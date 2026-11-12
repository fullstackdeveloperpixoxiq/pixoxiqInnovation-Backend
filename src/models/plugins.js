import env from '../config/env.js';

// Clean JSON output: include virtuals, expose `id`, drop `__v`
export const toJSONPlugin = (schema) => {
  const transform = (doc, ret) => {
    ret.id = ret._id?.toString();
    delete ret.__v;
    return ret;
  };
  schema.set('toJSON', { virtuals: true, transform });
  schema.set('toObject', { virtuals: true, transform });
};

// Turns a stored relative upload path into an absolute URL
export const fileUrl = (value) => {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `${env.apiPublicUrl}/uploads/${value}`;
};

export const LUCIDE_ICON_DEFAULT = 'Award';
