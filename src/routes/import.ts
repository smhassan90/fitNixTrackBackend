import { Router, Response } from 'express';
import { authenticateToken, AuthRequest, requireRole } from '../middleware/auth';
import { requireGymId } from '../middleware/multiTenant';
import { validate } from '../middleware/validation';
import { uploadCsvSingle, readUploadedCsv } from '../middleware/csvUpload';
import { importQuerySchema, importTemplateSchema } from '../validations/import';
import { sendSuccess, sendError } from '../utils/response';
import { IMPORT_TEMPLATES } from '../utils/importColumnMap';
import {
  importMembersFromCsv,
  importPackagesFromCsv,
  importTrainersFromCsv,
  assignMemberTrainersFromCsv,
  importPaymentsFromCsv,
} from '../services/bulkImportService';

const router = Router();

router.use(authenticateToken);
router.use(requireGymId);

router.get(
  '/templates/:type',
  validate(importTemplateSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const { type } = req.params as { type: 'packages' | 'trainers' | 'members' | 'payments' };
      const csv = IMPORT_TEMPLATES[type];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${type}-import-template.csv"`);
      res.send(csv);
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/packages',
  requireRole('GYM_ADMIN', 'GYM_MANAGER'),
  uploadCsvSingle('file'),
  validate(importQuerySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const dryRun = (req.query as { dryRun?: boolean }).dryRun === true;
      const csvText = readUploadedCsv(req);
      const result = await importPackagesFromCsv(gymId, csvText, dryRun);
      sendSuccess(res, result, dryRun ? 'Dry run completed' : 'Packages imported');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/trainers',
  requireRole('GYM_ADMIN', 'GYM_MANAGER'),
  uploadCsvSingle('file'),
  validate(importQuerySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const dryRun = (req.query as { dryRun?: boolean }).dryRun === true;
      const csvText = readUploadedCsv(req);
      const result = await importTrainersFromCsv(gymId, csvText, dryRun);
      sendSuccess(res, result, dryRun ? 'Dry run completed' : 'Trainers imported');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/members/assign-trainers',
  requireRole('GYM_ADMIN', 'GYM_MANAGER'),
  uploadCsvSingle('file'),
  validate(importQuerySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const q = req.query as {
        dryRun?: boolean;
        createMissingTrainers?: boolean;
      };
      const dryRun = q.dryRun === true;
      const createMissingTrainers = q.createMissingTrainers === true;
      const csvText = readUploadedCsv(req);
      const result = await assignMemberTrainersFromCsv(gymId, csvText, {
        dryRun,
        createMissingTrainers,
      });
      sendSuccess(res, result, dryRun ? 'Dry run completed' : 'Trainer assignments updated');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/members',
  requireRole('GYM_ADMIN', 'GYM_MANAGER'),
  uploadCsvSingle('file'),
  validate(importQuerySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const q = req.query as {
        dryRun?: boolean;
        admissionFeeWaived?: boolean;
        createMissingTrainers?: boolean;
      };
      const dryRun = q.dryRun === true;
      const admissionFeeWaived = q.admissionFeeWaived !== false;
      const createMissingTrainers = q.createMissingTrainers === true;
      const csvText = readUploadedCsv(req);
      const result = await importMembersFromCsv(gymId, csvText, {
        dryRun,
        admissionFeeWaived,
        createMissingTrainers,
      });
      sendSuccess(res, result, dryRun ? 'Dry run completed' : 'Members imported');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

router.post(
  '/payments',
  requireRole('GYM_ADMIN', 'GYM_MANAGER'),
  uploadCsvSingle('file'),
  validate(importQuerySchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const gymId = req.gymId!;
      const dryRun = (req.query as { dryRun?: boolean }).dryRun === true;
      const csvText = readUploadedCsv(req);
      const result = await importPaymentsFromCsv(gymId, csvText, dryRun);
      sendSuccess(res, result, dryRun ? 'Dry run completed' : 'Payments imported');
    } catch (error) {
      sendError(res, error as Error);
    }
  }
);

export default router;
