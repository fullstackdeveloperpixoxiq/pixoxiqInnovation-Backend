import VisitingCard from '../models/VisitingCard.js';
import StoredFile from '../models/StoredFile.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { removeUpload, sniffImageType } from '../middleware/upload.js';
import { pickFields } from './crudFactory.js';

const FIELDS = ['name', 'designation', 'company', 'website', 'email', 'phone', 'location', 'locationUrl'];
const IMAGES = ['frontImage', 'backImage'];

// The details printed on the default card images. This is the single source of defaults:
// the website has no hardcoded copy and reads everything from the public endpoint.
// Blank fields mean "use the default", so the admin sees these until something is customised.
const DEFAULTS = {
  name: 'Muhammed Musthafa',
  designation: 'Founder & CEO',
  company: 'pixoxiq innovations Pvt. Ltd.',
  website: 'https://www.pixoxiq.com',
  email: 'info@pixoxiq.com',
  phone: '+917356436944',
  location: '',
  locationUrl:
    'https://www.google.com/maps/place/pixoxiq+Innovations+Pvt+Ltd/@10.7743138,76.043856,17z/data=!3m1!4b1!4m6!3m5!1s0x3ba7b93e5bf1d0af:0xa9a89e70c7111abe!8m2!3d10.7743138!4d76.043856!16s%2Fg%2F11wqy_kk2b?entry=ttu&g_ep=EgoyMDI2MTEwOS4wIKXMDSoASAFQAw%3D%3D',
};

// Stored values, with defaults filled in for blank fields
const withDefaults = (doc) => {
  const out = doc ? doc.toJSON() : {};
  FIELDS.forEach((f) => {
    if (!out[f]) out[f] = DEFAULTS[f];
  });
  return out;
};

const getOrCreate = () =>
  VisitingCard.findOneAndUpdate({ key: 'main' }, { $setOnInsert: { key: 'main' } }, { upsert: true, new: true });

const uploadedPath = (file) => (file ? `visiting-card/${file.filename}` : undefined);

// Admin: current card content
export const getCard = asyncHandler(async (req, res) => {
  res.json({ success: true, data: withDefaults(await getOrCreate()) });
});

// Public: read-only content for the website, limited to the fields the page displays.
// Never creates the record; before the first save it simply returns the defaults.
export const getPublicCard = asyncHandler(async (req, res) => {
  const card = withDefaults(await VisitingCard.findOne({ key: 'main' }));
  const data = Object.fromEntries(FIELDS.map((f) => [f, card[f]]));
  data.frontImageUrl = card.frontImageUrl || null;
  data.backImageUrl = card.backImageUrl || null;
  data.profilePhotoUrl = card.profilePhotoUrl || null;
  res.json({ success: true, data });
});

const removeStoredFile = (id) => {
  if (id) StoredFile.deleteOne({ _id: id }).catch(() => {});
};

// Admin: update text fields and optionally replace/remove the front/back images and the
// founder profile photo
export const updateCard = asyncHandler(async (req, res) => {
  const files = req.files || {};
  const newPaths = IMAGES.map((f) => uploadedPath(files[f]?.[0]));
  const photoFile = files.profilePhoto?.[0];
  const photoType = photoFile && sniffImageType(photoFile.buffer);
  let newPhotoId;

  try {
    if (photoFile && !photoType) throw ApiError.badRequest('Profile photo must be a valid JPG, PNG or WEBP image');

    const doc = await getOrCreate();
    const previous = { profilePhoto: doc.profilePhoto };

    doc.set(pickFields(req.body, FIELDS));

    IMAGES.forEach((field, i) => {
      previous[field] = doc[field];
      if (newPaths[i]) doc[field] = newPaths[i];
      else if (req.body[`remove${field[0].toUpperCase()}${field.slice(1)}`] === 'true') doc[field] = '';
    });

    if (photoFile) {
      const stored = await StoredFile.create({
        data: photoFile.buffer,
        contentType: photoType,
        size: photoFile.size,
        purpose: 'visiting-card/profile-photo',
      });
      newPhotoId = stored.id;
      doc.profilePhoto = newPhotoId;
    } else if (req.body.removeProfilePhoto === 'true') {
      doc.profilePhoto = '';
    }

    await doc.save();

    // Saved: the files this update replaced or removed are no longer referenced
    IMAGES.forEach((field) => {
      if (previous[field] && previous[field] !== doc[field]) removeUpload(previous[field]);
    });
    if (previous.profilePhoto && previous.profilePhoto !== doc.profilePhoto) removeStoredFile(previous.profilePhoto);

    res.json({ success: true, message: 'Visiting card updated', data: withDefaults(doc) });
  } catch (err) {
    newPaths.forEach(removeUpload);
    removeStoredFile(newPhotoId);
    throw err;
  }
});
