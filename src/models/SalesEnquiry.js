import mongoose from 'mongoose';
import { toJSONPlugin } from './plugins.js';

export const ENQUIRY_STATUSES = ['new', 'quoted', 'confirmed', 'lost'];
export const MAX_PRODUCTS = 20;
export const MAX_IMAGES_PER_PRODUCT = 5;

// A product the client wants. Images are kept in the database (StoredFile) and served to staff only.
const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Product name is required'], trim: true, maxlength: 150 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    price: { type: Number, min: [0, 'Price cannot be negative'], default: 0 },
    quantity: { type: Number, min: [0, 'Quantity cannot be negative'], default: 1 },
    total: { type: Number, default: 0 },
    images: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'StoredFile' }],
      validate: [(v) => v.length <= MAX_IMAGES_PER_PRODUCT, `Up to ${MAX_IMAGES_PER_PRODUCT} images per product`],
    },
  },
  { _id: true }
);

// Client enquiry recorded by the sales team through the sales portal (pixoxiq.com/sales-portal).
// Each enquiry is also created as a lead in Odoo CRM.
const salesEnquirySchema = new mongoose.Schema(
  {
    // Client details
    clientName: { type: String, required: [true, 'Client name is required'], trim: true, maxlength: 100 },
    phone: {
      type: String,
      required: [true, 'Phone is required'],
      trim: true,
      maxlength: 25,
      match: [/^\+?[0-9\s()-]{6,20}$/, 'Enter a valid phone number'],
    },
    place: { type: String, required: [true, 'Place is required'], trim: true, maxlength: 120 },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      maxlength: 254,
      default: '',
      match: [/^$|^\S+@\S+\.\S+$/, 'Enter a valid email'],
    },
    company: { type: String, trim: true, maxlength: 120, default: '' },

    // Requirements
    hasEcommerce: { type: Boolean, default: false },
    needsEcommerce: { type: Boolean, default: false },
    hasBrand: { type: Boolean, default: false },
    brandName: { type: String, trim: true, maxlength: 120, default: '' },
    needsBranding: { type: Boolean, default: false },
    notes: { type: String, trim: true, maxlength: 5000, default: '' },

    products: {
      type: [productSchema],
      validate: [(v) => v.length <= MAX_PRODUCTS, `Up to ${MAX_PRODUCTS} products per enquiry`],
    },
    grandTotal: { type: Number, default: 0 },

    status: { type: String, enum: ENQUIRY_STATUSES, default: 'new' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },

    // Odoo sync: CRM lead id (null until pushed) and the images already attached to it
    odooId: { type: Number, default: null, index: true },
    odooSyncedAt: Date,
    odooAttempts: { type: Number, default: 0 },
    odooError: { type: String, default: '' },
    odooDirty: { type: Boolean, default: true },
    odooFiles: { type: [{ type: mongoose.Schema.Types.ObjectId }], default: [] },
  },
  { timestamps: true }
);

// Totals are always computed on the server
salesEnquirySchema.pre('validate', function computeTotals(next) {
  let sum = 0;
  this.products.forEach((p) => {
    p.total = Math.round((Number(p.price) || 0) * (Number(p.quantity) || 0) * 100) / 100;
    sum += p.total;
  });
  this.grandTotal = Math.round(sum * 100) / 100;
  if (!this.hasBrand) this.brandName = '';
  next();
});

salesEnquirySchema.index({ status: 1, createdAt: -1 });

salesEnquirySchema.plugin(toJSONPlugin);

export default mongoose.model('SalesEnquiry', salesEnquirySchema);
