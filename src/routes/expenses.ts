import { Router, Response } from 'express';
import { validate } from '../middleware/validation';
import {
  authenticateToken,
  AuthRequest,
  requireGymPermission,
} from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import { sendSuccess, sendError } from '../utils/response';
import {
  listExpenseCategoriesSchema,
  createExpenseCategorySchema,
  updateExpenseCategorySchema,
  getExpenseCategorySchema,
  listExpenseEntriesSchema,
  createExpenseEntrySchema,
  updateExpenseEntrySchema,
  getExpenseEntrySchema,
} from '../validations/expenses';
import {
  listExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  deactivateExpenseCategory,
  listExpenseEntries,
  createExpenseEntry,
  updateExpenseEntry,
  deleteExpenseEntry,
} from '../services/expenseService';

const router = Router();

router.use(authenticateToken);
router.use(requireGymId);

router.get(
  '/categories',
  requireGymPermission('gym.expenses.read'),
  validate(listExpenseCategoriesSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const includeInactive = Boolean((req.query as { includeInactive?: boolean }).includeInactive);
      const categories = await listExpenseCategories(req.gymId!, includeInactive);
      sendSuccess(res, { categories });
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/categories',
  requireGymPermission('gym.expenses.manage'),
  validate(createExpenseCategorySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const category = await createExpenseCategory(req.gymId!, req.body);
      sendSuccess(res, category, 'Expense head created');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.patch(
  '/categories/:id',
  requireGymPermission('gym.expenses.manage'),
  validate(updateExpenseCategorySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const category = await updateExpenseCategory(req.gymId!, Number(req.params.id), req.body);
      sendSuccess(res, category, 'Expense head updated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.delete(
  '/categories/:id',
  requireGymPermission('gym.expenses.delete'),
  validate(getExpenseCategorySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const category = await deactivateExpenseCategory(req.gymId!, Number(req.params.id));
      sendSuccess(res, category, 'Expense head deactivated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.get(
  '/',
  requireGymPermission('gym.expenses.read'),
  validate(listExpenseEntriesSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const q = req.query as {
        from?: string;
        to?: string;
        categoryId?: number;
        kind?: 'FIXED' | 'PETTY' | 'OTHER';
        page?: number;
        limit?: number;
      };
      const data = await listExpenseEntries(req.gymId!, q);
      sendSuccess(res, data);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/',
  requireGymPermission('gym.expenses.manage'),
  validate(createExpenseEntrySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const entry = await createExpenseEntry(req.gymId!, req.user!.id, req.body);
      sendSuccess(res, entry, 'Expense recorded');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.patch(
  '/:id',
  requireGymPermission('gym.expenses.manage'),
  validate(updateExpenseEntrySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const entry = await updateExpenseEntry(req.gymId!, req.user!.id, Number(req.params.id), req.body);
      sendSuccess(res, entry, 'Expense updated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.delete(
  '/:id',
  requireGymPermission('gym.expenses.delete'),
  validate(getExpenseEntrySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      await deleteExpenseEntry(req.gymId!, Number(req.params.id));
      sendSuccess(res, { id: Number(req.params.id) }, 'Expense deleted');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
