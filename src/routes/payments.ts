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
  deletePaymentSchema,
} from '../validations/payments';
import { sendSuccess, sendError } from '../utils/response';
import { NotFoundError, ValidationError } from '../utils/errors';
import { parseDate } from '../utils/dateHelpers';
import { markPaymentAsPaid, markOverduePayments } from '../services/paymentService';

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
      const limitNum = typeof limit === 'number' ? limit : parseInt(limit as string, 10) || 50;

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
        ];
      }

      // If filtering by PENDING or OVERDUE, only show next payment per member
      let payments: any[] = [];
      let total = 0;

      // Check if we should filter to next payment per member
      // This applies when filtering by PENDING or OVERDUE status
      const isPendingOrOverdue = normalizedStatus === 'PENDING' || normalizedStatus === 'OVERDUE';

      console.log(`[Payments API] Status: "${status}", Normalized: "${normalizedStatus}", Should filter next payment: ${isPendingOrOverdue}`);

      if (isPendingOrOverdue) {
        // Get all payments matching the status (and other filters like memberId, search, etc.)
        const allPayments = await prisma.payment.findMany({
          where,
          include: {
            member: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
              },
            },
          },
          orderBy: {
            dueDate: 'asc',
          },
        });

        console.log(`[Payments API] Status: ${status}, Found ${allPayments.length} payments before filtering`);

        // Group by member and get only the next upcoming payment for each
        // This ensures we only show 1 pending/overdue payment per member (the next one)
        const memberNextPayments = new Map<number, typeof allPayments[0]>();
        
        for (const payment of allPayments) {
          const existing = memberNextPayments.get(payment.memberId);
          // If no payment for this member yet, or this one has an earlier due date, use this one
          if (!existing || payment.dueDate < existing.dueDate) {
            memberNextPayments.set(payment.memberId, payment);
          }
        }

        // Convert to array and apply sorting, pagination
        payments = Array.from(memberNextPayments.values());
        total = payments.length;

        console.log(`[Payments API] After filtering to next payment per member: ${total} payments`);

        // Apply sorting
        payments.sort((a, b) => {
          const aVal = (a as any)[sortBy];
          const bVal = (b as any)[sortBy];
          if (sortOrder === 'asc') {
            return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
          } else {
            return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
          }
        });

        // Apply pagination
        payments = payments.slice((pageNum - 1) * limitNum, pageNum * limitNum);
      } else {
        // For other statuses (PAID) or no status filter, show all payments
        total = await prisma.payment.count({ where });

        payments = await prisma.payment.findMany({
          where,
          include: {
            member: {
              select: {
                id: true,
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
        payments,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      });
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

      sendSuccess(res, payment);
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
              name: true,
              email: true,
              phone: true,
            },
          },
        },
      });

      sendSuccess(res, payment, 'Payment created successfully', 201);
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
              name: true,
              email: true,
              phone: true,
            },
          },
        },
      });

      sendSuccess(res, payment, 'Payment updated successfully');
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
              name: true,
              email: true,
              phone: true,
            },
          },
        },
      });

      sendSuccess(res, payment, 'Payment marked as paid');
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

      const payment = await (prisma.payment.findFirst({
        where: { id: id as any, gymId: gymId as any },
        include: {
          member: true,
          gym: true,
        },
      }) as any);

      if (!payment) {
        sendError(res, new NotFoundError('Payment', id));
        return;
      }

      // Generate receipt data (JSON format - can be extended to PDF)
      const receipt = {
        receiptNumber: payment.id,
        date: payment.paidDate || payment.createdAt,
        member: {
          name: payment.member?.name || '',
          email: payment.member?.email || '',
          phone: payment.member?.phone || '',
        },
        gym: {
          name: payment.gym?.name || '',
          address: payment.gym?.address || '',
          phone: payment.gym?.phone || '',
        },
        payment: {
          month: payment.month,
          amount: payment.amount,
          status: payment.status,
          dueDate: payment.dueDate,
          paidDate: payment.paidDate,
        },
      };

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

// POST /api/payments/generate-overdue
router.post(
  '/generate-overdue',
  authenticateToken,
  requireGymId,
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;

      const count = await markOverduePayments(gymId);

      sendSuccess(res, { markedOverdue: count }, `Marked ${count} payments as overdue`);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;

