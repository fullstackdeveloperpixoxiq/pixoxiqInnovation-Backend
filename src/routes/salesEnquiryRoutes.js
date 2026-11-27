import { Router } from 'express';
import multer from 'multer';
import ApiError from '../utils/ApiError.js';
import {
  listEnquiries,
  getEnquiry,
  createEnquiry,
  updateEnquiry,
  deleteEnquiry,
  getEnquiryImage,
} from '../controllers/salesEnquiryController.js';
import { MAX_PRODUCTS, MAX_IMAGES_PER_PRODUCT } from '../models/SalesEnquiry.js';

// Product images: kept in memory, type checked from content and saved by the controller.
// Field names are product_<index>, so any() is used and the controller validates the names.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: Math.min(MAX_PRODUCTS * MAX_IMAGES_PER_PRODUCT, 40), fields: 20 },
  fileFilter: (req, file, cb) => {
    if (!/^product_\d+$/.test(file.fieldname)) return cb(ApiError.badRequest('Unexpected file field'));
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(null, true);
    cb(ApiError.badRequest('Only JPG, PNG or WEBP images are allowed'));
  },
}).any();

// Mounted at /api/sales-enquiries behind protect: sales users, admins and superadmins
const router = Router();

router.route('/').get(listEnquiries).post(upload, createEnquiry);
router.route('/:id').get(getEnquiry).put(upload, updateEnquiry).delete(deleteEnquiry);
router.get('/:id/images/:fileId', getEnquiryImage);

export default router;
