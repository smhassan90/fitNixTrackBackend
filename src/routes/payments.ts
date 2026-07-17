import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { validate } from '../middleware/validation';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import {
  createPaymentSchema,
  updatePaymentSchema,
  getPaymentsSchema,
  getPaymentSchema,
  markPaidSchema,
  markOneTimePaidSchema,
  deletePaymentSchema,
  getMemberPaymentSummariesSchema,
  bulkMarkPaidSchema,
  markMonthPaidPaymentsSchema,
} from '../validations/payments';
import { getPaymentsReceivedDailySchema } from '../validations/reports';
import { getPaymentsReceivedDaily } from '../services/reportService';
import { sendSuccess, sendError, buildPagination } from '../utils/response';
import { NotFoundError, ValidationError } from '../utils/errors';
import { parseDate } from '../utils/dateHelpers';
import { mapRowMemberNumber, mapRowsMemberNumber } from '../utils/memberPublic';
import {
  markPaymentAsPaid,
  markOverduePayments,
  getMemberPaymentSummaries,
  markPaymentsAsPaidBulk,
  markMonthlyInstallmentByYearMonth,
  markLastPaidInstallmentUnpaid,
  markSignupOneTimePaidAtDate,
} from '../services/paymentService';
import {
  buildMonthlyPaymentReceipt,
  buildOneTimePaymentReceipt,
  buildReceiptPrintedBy,
  findPaidSignupOneTimeForMemberMonth,
} from '../services/receiptService';

const router = Router();

// All routes require authentication and gymId
router.use(authenticateToken);
router.use(requireGymId);

// GET /api/payments
router.get(
  '/',
  validate(getPaymentsSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      
      // Automatically mark overdue payments before fetching
      await markOverduePayments(gymId);
      
      // Get validated query parameters (validation middleware transforms them)
      const query = req.query as any;
      const {
        memberId,
        status,
        month,
        search,
        sortBy = 'dueDate',
        sortOrder = 'desc',
        page,
        limit,
      } = query;

      // Ensure page and limit are numbers
      const pageNum = typeof page === 'number' ? page : parseInt(page as string, 10) || 1;
      const limitNum = typeof limit === 'number' ? limit : parseInt(limit as string, 10) || 25;

      const where: any = { gymId };

      // memberId is already transformed to number by validation middleware
      if (memberId) {
        const memberIdNum = typeof memberId === 'number' ? memberId : parseInt(memberId as string, 10);
        if (!isNaN(memberIdNum)) {
          where.memberId = memberIdNum;
        }
      }
      // Normalize status to ensure consistent comparison
      const normalizedStatus = status ? String(status).toUpperCase() : null;
      if (normalizedStatus) where.status = normalizedStatus as 'PENDING' | 'PAID' | 'OVERDUE';
      if (month) where.month = month;

      // Search filter
      if (search) {
        where.OR = [
          { month: { contains: search } },
          { member: { name: { contains: search } } },
          { member: { email: { contains: search } } },
          { member: { legacyMemberId: { contains: search } } },
          { member: { phone: { contains: search } } },
        ];
      }

      // If filtering by PENDING or OVERDUE, only show next payment per member
      let payments: any[] = [];
      let total = 0;

      // Check if we should filter to next payment per member
      // This applies when filtering by PENDING or OVERDUE status
      const isPendingOrOverdue = normalizedStatus === 'PENDING' || normalizedStatus === 'OVERDUE';

      if (isPendingOrOverdue) {
        // One next payment per member — aggregate in DB, paginate member IDs, then fetch page rows only
        const memberGroups = await prisma.payment.groupBy({
          by: ['memberId'],
          where,
          _min: { dueDate: true },
        });

        memberGroups.sort((a, b) => {
          const aTime = a._min.dueDate?.getTime() ?? 0;
          const bTime = b._min.dueDate?.getTime() ?? 0;
          if (sortOrder === 'asc') {
            return aTime - bTime;
          }
          return bTime - aTime;
        });

        total = memberGroups.length;
        const pageGroups = memberGroups.slice((pageNum - 1) * limitNum, pageNum * limitNum);

        if (pageGroups.length === 0) {
          payments = [];
        } else {
          const pagePayments = await Promise.all(
            pageGroups.map((group) =>
              prisma.payment.findFirst({
                where: {
                  ...where,
                  memberId: group.memberId,
                  dueDate: group._min.dueDate ?? undefined,
                },
                include: {
                  member: {
                    select: {
                      id: true,
                      legacyMemberId: true,
                      name: true,
                      email: true,
                      phone: true,
                    },
                  },
                },
                orderBy: { id: 'asc' },
              })
            )
          );
          payments = pagePayments.filter((p): p is NonNullable<typeof p> => p != null);

          if (sortBy !== 'dueDate') {
            payments.sort((a, b) => {
              const aVal = (a as any)[sortBy];
              const bVal = (b as any)[sortBy];
              if (sortOrder === 'asc') {
                return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
              }
              return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
            });
          }
        }
      } else {
        // For other statuses (PAID) or no status filter, show all payments
        total = await prisma.payment.count({ where });

        payments = await prisma.payment.findMany({
          where,
          include: {
            member: {
              select: {
                id: true,
                legacyMemberId: true,
                name: true,
                email: true,
                phone: true,
              },
            },
          },
          orderBy: { [sortBy]: sortOrder },
          skip: (pageNum - 1) * limitNum,
          take: limitNum,
        });
      }

      sendSuccess(res, {
        payments: mapRowsMemberNumber(payments),
        pagination: buildPagination(pageNum, limitNum, total),
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/payments/member-summaries — one entry per member (main payment screen)
router.get(
  '/member-summaries',
  validate(getMemberPaymentSummariesSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const q = req.query as any;
      const pageNum = typeof q.page === 'number' ? q.page : parseInt(q.page as string, 10) || 1;
      const limitNum = typeof q.limit === 'number' ? q.limit : parseInt(q.limit as string, 10) || 25;

      const { rows, total } = await getMemberPaymentSummaries(gymId, {
        search: q.search,
        onlyWithOpenInstallments: q.onlyWithOpenInstallments === true,
        page: pageNum,
        limit: limitNum,
        sortBy: q.sortBy ?? 'nextDueDate',
        sortOrder: q.sortOrder ?? 'asc',
      });

      sendSuccess(res, {
        members: rows,
        pagination: buildPagination(pageNum, limitNum, total),
      });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/payments/received-daily — alias for /api/reports/payments-received-daily (portal probe)
router.get(
  '/received-daily',
  validate(getPaymentsReceivedDailySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { startDate, endDate } = req.query as { startDate: string; endDate: string };
      const data = await getPaymentsReceivedDaily(gymId, startDate, endDate);
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/payments/bulk-mark-paid — pay multiple monthly installments at once (same member)
router.post(
  '/bulk-mark-paid',
  validate(bulkMarkPaidSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      await markOverduePayments(gymId);
      const { paymentIds } = req.body;
      const result = await markPaymentsAsPaidBulk(paymentIds, gymId);

      const updated = await prisma.payment.findMany({
        where: { id: { in: result.paidIds }, gymId },
        include: {
          member: {
            select: {
              id: true,
              legacyMemberId: true,
              name: true,
              email: true,
              phone: true,
            },
          },
        },
        orderBy: { dueDate: 'asc' },
      });

      sendSuccess(res, { payments: mapRowsMemberNumber(updated), paidIds: result.paidIds }, 'Payments marked as paid');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/payments/mark-month-paid — portal fallback path (memberId + month in body)
router.post(
  '/mark-month-paid',
  validate(markMonthPaidPaymentsSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { memberId, month } = req.body as { memberId: number; month: string };
      const updated = await markMonthlyInstallmentByYearMonth(gymId, memberId, month);
      sendSuccess(res, updated, 'Payment marked as paid');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/payments/generate-overdue
router.post('/generate-overdue', async (req: AuthRequest, res: Response) => {
  try {
    const gymId = req.gymId!;
    const count = await markOverduePayments(gymId);
    sendSuccess(res, { markedOverdue: count }, `Marked ${count} payments as overdue`);
  } catch (error) {
    sendError(res, error as Error);
  }
});

// GET /api/payments/one-time - Get all one-time payments
router.get('/one-time', validate(getPaymentsSchema), async (req: AuthRequest, res: Response) => {
  try {
    const gymId = req.gymId!;
    const query = req.query as any;
    const {
      memberId,
      status,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page,
      limit,
    } = query;

    const pageNum = typeof page === 'number' ? page : parseInt(page as string, 10) || 1;
    const limitNum = typeof limit === 'number' ? limit : parseInt(limit as string, 10) || 25;

    const where: any = { gymId };

    if (memberId) {
      const memberIdNum = typeof memberId === 'number' ? memberId : parseInt(memberId as string, 10);
      if (!isNaN(memberIdNum)) {
        where.memberId = memberIdNum;
      }
    }

    const normalizedStatus = status ? String(status).toUpperCase() : null;
    if (normalizedStatus) where.status = normalizedStatus as 'PENDING' | 'PAID' | 'OVERDUE';

    const [total, oneTimePayments] = await Promise.all([
      prisma.oneTimePayment.count({ where }),
      prisma.oneTimePayment.findMany({
        where,
        include: {
          member: {
            select: {
              id: true,
              legacyMemberId: true,
              name: true,
              email: true,
              phone: true,
            },
          },
        },
        orderBy: { [sortBy]: sortOrder },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
    ]);

    sendSuccess(res, {
      oneTimePayments: mapRowsMemberNumber(oneTimePayments),
      pagination: buildPagination(pageNum, limitNum, total),
    });
  } catch (error) {
    sendError(res, error as Error);
  }
});

// PATCH /api/payments/one-time/:id/mark-paid - Mark one-time payment as paid
router.patch(
  '/one-time/:id/mark-paid',
  validate(markOneTimePaidSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = parseInt(req.params.id, 10);
      const body = (req.body ?? {}) as { paidDate?: string };

      const oneTimePayment = await prisma.oneTimePayment.findFirst({
        where: { id, gymId },
        include: {
          member: {
            select: {
              id: true,
              legacyMemberId: true,
              name: true,
              email: true,
              phone: true,
            },
          },
        },
      });

      if (!oneTimePayment) {
        sendError(res, new NotFoundError('One-time payment', id));
        return;
      }

      if (oneTimePayment.status === 'PAID') {
        sendError(res, new ValidationError('One-time payment is already marked paid'));
        return;
      }

      const paidDateInput = body.paidDate ? parseDate(body.paidDate) : undefined;
      await markSignupOneTimePaidAtDate(id, gymId, {
        paidDate: paidDateInput,
        seedMonthly: true,
      });

      const updated = await prisma.oneTimePayment.findFirst({
        where: { id, gymId },
        include: {
          member: {
            select: {
              id: true,
              legacyMemberId: true,
              name: true,
              email: true,
              phone: true,
            },
          },
        },
      });

      if (!updated) {
        sendError(res, new NotFoundError('One-time payment', id));
        return;
      }

      sendSuccess(res, mapRowMemberNumber(updated), 'One-time payment marked as paid');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/payments/one-time/:id/receipt - Receipt for signup/admission payment
router.get(
  '/one-time/:id/receipt',
  validate(getPaymentSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = parseInt(req.params.id, 10);

      const oneTimePayment = await prisma.oneTimePayment.findFirst({
        where: { id, gymId },
        include: {
          member: {
            include: {
              package: {
                include: {
                  features: {
                    include: { feature: { select: { name: true } } },
                  },
                },
              },
              trainers: {
                include: {
                  trainer: { select: { id: true, name: true, charges: true } },
                },
              },
            },
          },
          gym: {
            select: {
              id: true,
              name: true,
              logoUrl: true,
              address: true,
              city: true,
              country: true,
              phone: true,
              email: true,
            },
          },
        },
      });

      if (!oneTimePayment) {
        sendError(res, new NotFoundError('One-time payment', id));
        return;
      }

      const receipt = buildOneTimePaymentReceipt({
        oneTimePayment,
        member: oneTimePayment.member,
        gym: {
          id: oneTimePayment.gym.id,
          name: oneTimePayment.gym.name ?? '',
          logoUrl: oneTimePayment.gym.logoUrl ?? null,
          address: oneTimePayment.gym.address ?? null,
          city: oneTimePayment.gym.city ?? null,
          country: oneTimePayment.gym.country ?? null,
          phone: oneTimePayment.gym.phone ?? null,
          email: oneTimePayment.gym.email ?? null,
        },
        printedBy: buildReceiptPrintedBy(req.user),
      });

      sendSuccess(res, receipt);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/payments/:id
router.get(
  '/:id',
  validate(getPaymentSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = parseInt(req.params.id, 10);

      const payment = await prisma.payment.findFirst({
        where: { id: id as any, gymId: gymId as any },
        include: {
          member: true,
        },
      });

      if (!payment) {
        sendError(res, new NotFoundError('Payment', id));
        return;
      }

      sendSuccess(res, mapRowMemberNumber(payment));
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// POST /api/payments
router.post(
  '/',
  validate(createPaymentSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const { memberId, month, amount, dueDate } = req.body;

      // Validate member exists
      const member = await prisma.member.findFirst({
        where: { id: memberId, gymId },
      });

      if (!member) {
        sendError(res, new NotFoundError('Member', memberId));
        return;
      }

      // Check if payment for this month already exists
      const existingPayment = await prisma.payment.findFirst({
        where: {
          gymId,
          memberId,
          month,
        },
      });

      if (existingPayment) {
        sendError(res, new ValidationError('Payment already exists for this month'));
        return;
      }

      // Parse due date
      const due = parseDate(dueDate);

      // Create payment
      const payment = await prisma.payment.create({
        data: {
          gymId,
          memberId,
          month,
          amount,
          dueDate: due,
          status: 'PENDING',
        },
        include: {
          member: {
            select: {
              id: true,
              legacyMemberId: true,
              name: true,
              email: true,
              phone: true,
            },
          },
        },
      });

      sendSuccess(res, mapRowMemberNumber(payment), 'Payment created successfully', 201);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// PUT /api/payments/:id
router.put(
  '/:id',
  validate(updatePaymentSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = parseInt(req.params.id, 10);
      const { month, amount, dueDate, status } = req.body;

      // Check if payment exists
      const existingPayment = await prisma.payment.findFirst({
        where: { id: id as any, gymId: gymId as any },
      });

      if (!existingPayment) {
        sendError(res, new NotFoundError('Payment', id));
        return;
      }

      // Update payment
      const updateData: any = {};
      if (month !== undefined) updateData.month = month;
      if (amount !== undefined) updateData.amount = amount;
      if (dueDate !== undefined) updateData.dueDate = parseDate(dueDate);
      if (status !== undefined) updateData.status = status;

      const payment = await prisma.payment.update({
        where: { id: id as any },
        data: updateData,
        include: {
          member: {
            select: {
              id: true,
              legacyMemberId: true,
              name: true,
              email: true,
              phone: true,
            },
          },
        },
      });

      sendSuccess(res, mapRowMemberNumber(payment), 'Payment updated successfully');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// PATCH /api/payments/:id/mark-paid
router.patch(
  '/:id/mark-paid',
  validate(markPaidSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = parseInt(req.params.id, 10);

      await markPaymentAsPaid(id, gymId);

      const payment = await prisma.payment.findFirst({
        where: { id: id as any, gymId: gymId as any },
        include: {
          member: {
            select: {
              id: true,
              legacyMemberId: true,
              name: true,
              email: true,
              phone: true,
            },
          },
        },
      });

      if (!payment) {
        sendError(res, new NotFoundError('Payment', id));
        return;
      }

      sendSuccess(res, mapRowMemberNumber(payment), 'Payment marked as paid');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// PATCH /api/payments/:id/mark-unpaid — only the member's latest PAID installment by dueDate (LIFO)
router.patch(
  '/:id/mark-unpaid',
  validate(markPaidSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = parseInt(req.params.id, 10);
      const updated = await markLastPaidInstallmentUnpaid(id, gymId);
      sendSuccess(res, updated, 'Payment marked as unpaid');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// GET /api/payments/:id/receipt
router.get(
  '/:id/receipt',
  validate(getPaymentSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = parseInt(req.params.id, 10);

      const payment = await prisma.payment.findFirst({
        where: { id, gymId },
        include: {
          member: {
            include: {
              package: {
                include: {
                  features: {
                    include: { feature: { select: { name: true } } },
                  },
                },
              },
              trainers: {
                include: {
                  trainer: { select: { id: true, name: true, charges: true } },
                },
              },
            },
          },
          gym: {
            select: {
              id: true,
              name: true,
              logoUrl: true,
              address: true,
              city: true,
              country: true,
              phone: true,
              email: true,
            },
          },
        },
      });

      if (!payment) {
        sendError(res, new NotFoundError('Payment', id));
        return;
      }

      const member = payment.member;
      const signupOneTime = await findPaidSignupOneTimeForMemberMonth(
        gymId,
        payment.memberId,
        payment.month,
        member?.membershipStart
      );

      const receipt = buildMonthlyPaymentReceipt({
        payment,
        member: member!,
        gym: {
          id: payment.gym?.id ?? gymId,
          name: payment.gym?.name ?? '',
          logoUrl: payment.gym?.logoUrl ?? null,
          address: payment.gym?.address ?? null,
          city: payment.gym?.city ?? null,
          country: payment.gym?.country ?? null,
          phone: payment.gym?.phone ?? null,
          email: payment.gym?.email ?? null,
        },
        printedBy: buildReceiptPrintedBy(req.user),
        signupOneTime,
      });

      sendSuccess(res, receipt);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

// DELETE /api/payments/:id
router.delete(
  '/:id',
  validate(deletePaymentSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const id = parseInt(req.params.id, 10);

      const payment = await prisma.payment.findFirst({
        where: { id: id as any, gymId: gymId as any },
      });

      if (!payment) {
        sendError(res, new NotFoundError('Payment', id));
        return;
      }

      await prisma.payment.delete({
        where: { id: id as any },
      });

      sendSuccess(res, { message: 'Payment deleted successfully' });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;

