import crypto from 'crypto';
import ApiError from './ApiError.js';
import { ICON_NAMES } from './icons.js';

// Shape, defaults and sanitising for the website's About Us section (see models/About.js).
// The same structure is used for the draft and the published copy.

export const SECTION_KEYS = ['hero', 'intro', 'capabilities', 'visionMission', 'pillars', 'journey', 'cta'];
export const LIST_KEYS = { capabilities: 'capabilities', pillars: 'pillars', journey: 'journey' };
export const MAX_ITEMS = { capabilities: 12, pillars: 8, journey: 8, stats: 6, highlights: 8 };

export const newItemId = () => crypto.randomBytes(6).toString('hex');

export const DEFAULT_ABOUT = Object.freeze({
  sections: Object.fromEntries(SECTION_KEYS.map((k) => [k, true])),
  hero: {
    eyebrow: 'Who We Are',
    headline: 'Pioneering',
    highlight: 'Electronics Innovation',
    intro:
      'Pixoxiq Innovations Pvt. Ltd. is a premier consumer electronics manufacturer and end-to-end solution provider. We bridge the gap between concept and consumer, specialising in the R&D, design and mass production of smart gadgets, audio devices and IoT products.',
    image: '',
    primaryCta: { label: 'Partner With Us', url: '#contact' },
    secondaryCta: { label: 'Explore Services', url: '#services' },
  },
  intro: {
    eyebrow: 'The Company',
    heading: 'From concept to',
    highlight: 'market-ready reality',
    description:
      'We empower brands and businesses with complete product development, from the first idea to products on shelves around the world.',
    manufacturing:
      'With full-fledged manufacturing units and a dedicated R&D department, we take products from idea generation and validation through prototyping and design for manufacturing, backed by high-standard quality checks.',
    oem:
      'Comprehensive OEM/ODM services let partners launch under their own brand, using our engineering, tooling and production capacity.',
    makeInIndia:
      'As proud contributors to the Make in India and Make in Kerala initiatives, we export world-class electronics from India to global markets, establishing India as a hub for quality electronics manufacturing.',
    image: '',
    stats: [
      { id: 'stat-rd', value: 'In-house', label: 'R&D & engineering' },
      { id: 'stat-mfg', value: 'End-to-end', label: 'Manufacturing' },
      { id: 'stat-oem', value: 'OEM / ODM', label: 'Partnership models' },
      { id: 'stat-made', value: 'Made in India', label: 'For global markets' },
    ],
    highlights: ['Smart gadgets', 'Audio devices', 'IoT products', 'Quality-checked production'],
  },
  capabilities: {
    eyebrow: 'Our Capabilities',
    heading: 'Everything it takes to',
    highlight: 'build great electronics',
    description: 'One partner across the full product lifecycle, so ideas move faster from the whiteboard to the factory floor.',
    items: [
      {
        id: 'cap-rd',
        title: 'Research & Development',
        description: 'Market research, feasibility studies and technology exploration that turn ideas into validated product concepts.',
        icon: 'Lightbulb',
        image: '',
      },
      {
        id: 'cap-design',
        title: 'Product Design & Engineering',
        description: 'Industrial design, electronics, firmware and mechanical engineering, all designed for manufacturing from day one.',
        icon: 'CircuitBoard',
        image: '',
      },
      {
        id: 'cap-proto',
        title: 'Prototyping & Validation',
        description: 'Rapid prototypes, reliability testing and certification support to de-risk every launch.',
        icon: 'TestTube',
        image: '',
      },
      {
        id: 'cap-oem',
        title: 'OEM/ODM Manufacturing',
        description: 'Scalable production with rigorous quality control, for your brand or ours, from pilot runs to mass production.',
        icon: 'Factory',
        image: '',
      },
    ],
  },
  visionMission: {
    eyebrow: 'Purpose',
    heading: 'What drives',
    highlight: 'us forward',
    vision: {
      heading: 'Our Vision',
      quote: 'Enhancing everyday life with smart and seamless technology.',
      description:
        'We aspire to be a global leader in the electronics sector, where our technology seamlessly integrates into daily routines, making life smarter, easier and more connected.',
      image: '',
    },
    mission: {
      heading: 'Our Mission',
      quote: 'Innovation that meets reliability at every step.',
      description:
        'We are driven by a four-fold mission to deliver excellence in everything we create: innovate, simplify, sustain and expand.',
      image: '',
    },
  },
  pillars: {
    eyebrow: 'Our Principles',
    heading: 'Four Pillars of',
    highlight: 'Excellence',
    description: 'The principles that shape every product we design and every partnership we build.',
    items: [
      {
        id: 'pil-innovate',
        title: 'Innovate',
        subtitle: 'Push boundaries',
        description: 'Develop advanced, user-friendly electronics that push the boundaries of what is possible in consumer tech.',
        icon: 'Lightbulb',
      },
      {
        id: 'pil-simplify',
        title: 'Simplify',
        subtitle: 'Remove complexity',
        description: 'Make technology accessible and convenient, removing complexity to enhance the user experience.',
        icon: 'Layers',
      },
      {
        id: 'pil-sustain',
        title: 'Sustain',
        subtitle: 'Built to last',
        description: 'Focus on uncompromising quality, durability and efficiency in every product we manufacture.',
        icon: 'Shield',
      },
      {
        id: 'pil-expand',
        title: 'Expand',
        subtitle: 'Grow globally',
        description: 'Grow globally through robust OEM partnerships, retail expansion and international exports.',
        icon: 'Globe',
      },
    ],
  },
  journey: {
    eyebrow: 'Manufacturing Journey',
    heading: 'From idea to',
    highlight: 'delivery',
    description: 'A proven four-stage process that keeps quality, cost and timelines under control.',
    items: [
      { id: 'jr-ideate', title: 'Ideate', description: 'Define the product, its users and the market opportunity.', icon: 'Lightbulb' },
      { id: 'jr-engineer', title: 'Engineer', description: 'Design, prototype and validate electronics, firmware and enclosures.', icon: 'Cpu' },
      { id: 'jr-manufacture', title: 'Manufacture', description: 'Scale production with strict quality checks at every stage.', icon: 'Factory' },
      { id: 'jr-deliver', title: 'Deliver', description: 'Package, certify and ship to customers in India and worldwide.', icon: 'Truck' },
    ],
  },
  cta: {
    heading: 'Have a product idea? Let’s build it together.',
    description: 'Talk to our team about R&D, design or OEM/ODM manufacturing for your next electronics product.',
    buttonLabel: 'Start a Conversation',
    buttonUrl: '#contact',
  },
});

export const defaultAbout = () => structuredClone(DEFAULT_ABOUT);

// ---------- sanitising ----------

const LIMITS = { short: 80, title: 120, heading: 160, text: 1200, url: 500 };

// Plain text only: strips tags and control characters, collapses runs of spaces
export const cleanText = (value, max = LIMITS.text) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);
};

// Links: same-page anchors, site paths, http(s), mailto and tel. Anything else (javascript:, data:) is rejected.
export const cleanUrl = (value, field) => {
  const url = cleanText(value, LIMITS.url);
  if (!url) return '';
  if (/^(#|\/(?!\/))/.test(url) || /^(https?:\/\/|mailto:|tel:)/i.test(url)) return url;
  throw ApiError.badRequest(`${field}: links must start with #, /, https://, mailto: or tel:`);
};

// Images: uploaded files (absolute URLs from the upload endpoint) or any https/http image URL
export const cleanImage = (value, field) => {
  const url = cleanText(value, LIMITS.url);
  if (!url) return '';
  if (/^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url)) return url;
  throw ApiError.badRequest(`${field}: image must be an uploaded file or an http(s) URL`);
};

const cleanIcon = (value, fallback = 'Award') => (ICON_NAMES.includes(value) ? value : fallback);
const cleanId = (value) => (typeof value === 'string' && /^[\w-]{1,40}$/.test(value) ? value : newItemId());
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v, max, field) => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw ApiError.badRequest(`${field} must be a list`);
  if (v.length > max) throw ApiError.badRequest(`${field}: at most ${max} items are allowed`);
  return v;
};

const cta = (v, field) => {
  const o = obj(v);
  return { label: cleanText(o.label, LIMITS.short), url: cleanUrl(o.url, field) };
};

const sectionHeader = (o) => ({
  eyebrow: cleanText(o.eyebrow, LIMITS.short),
  heading: cleanText(o.heading, LIMITS.heading),
  highlight: cleanText(o.highlight, LIMITS.heading),
});

export const sanitizeCapability = (v, i = 0) => {
  const o = obj(v);
  const item = {
    id: cleanId(o.id),
    title: cleanText(o.title, LIMITS.title),
    description: cleanText(o.description),
    icon: cleanIcon(o.icon, 'Cpu'),
    image: cleanImage(o.image, `Capability ${i + 1} image`),
  };
  if (!item.title) throw ApiError.badRequest(`Capability ${i + 1}: title is required`);
  return item;
};

export const sanitizePillar = (v, i = 0) => {
  const o = obj(v);
  const item = {
    id: cleanId(o.id),
    title: cleanText(o.title, LIMITS.short),
    subtitle: cleanText(o.subtitle, LIMITS.title),
    description: cleanText(o.description),
    icon: cleanIcon(o.icon, 'Star'),
  };
  if (!item.title) throw ApiError.badRequest(`Pillar ${i + 1}: title is required`);
  return item;
};

export const sanitizeStage = (v, i = 0) => {
  const o = obj(v);
  const item = {
    id: cleanId(o.id),
    title: cleanText(o.title, LIMITS.short),
    description: cleanText(o.description),
    icon: cleanIcon(o.icon, 'Rocket'),
  };
  if (!item.title) throw ApiError.badRequest(`Journey stage ${i + 1}: title is required`);
  return item;
};

export const ITEM_SANITIZERS = { capabilities: sanitizeCapability, pillars: sanitizePillar, journey: sanitizeStage };

// Turns any client payload into a complete, valid About content object.
// Missing sections fall back to `base` (the current draft), so partial updates are allowed.
export const sanitizeAbout = (input, base = defaultAbout()) => {
  const src = obj(input);
  const pick = (key) => (src[key] === undefined ? base[key] : obj(src[key]));

  const sections = obj(src.sections === undefined ? base.sections : src.sections);
  const hero = pick('hero');
  const intro = pick('intro');
  const caps = pick('capabilities');
  const vm = pick('visionMission');
  const pillars = pick('pillars');
  const journey = pick('journey');
  const finalCta = pick('cta');

  const panel = (p, label) => {
    const o = obj(p);
    return {
      heading: cleanText(o.heading, LIMITS.short),
      quote: cleanText(o.quote, 300),
      description: cleanText(o.description),
      image: cleanImage(o.image, `${label} image`),
    };
  };

  const ids = new Set();
  const unique = (item) => {
    if (ids.has(item.id)) item.id = newItemId();
    ids.add(item.id);
    return item;
  };

  return {
    sections: Object.fromEntries(SECTION_KEYS.map((k) => [k, sections[k] !== false && sections[k] !== 'false'])),
    hero: {
      eyebrow: cleanText(hero.eyebrow, LIMITS.short),
      headline: cleanText(hero.headline, LIMITS.heading),
      highlight: cleanText(hero.highlight, LIMITS.heading),
      intro: cleanText(hero.intro),
      image: cleanImage(hero.image, 'Hero image'),
      primaryCta: cta(hero.primaryCta, 'Hero primary button'),
      secondaryCta: cta(hero.secondaryCta, 'Hero secondary button'),
    },
    intro: {
      ...sectionHeader(intro),
      description: cleanText(intro.description),
      manufacturing: cleanText(intro.manufacturing),
      oem: cleanText(intro.oem),
      makeInIndia: cleanText(intro.makeInIndia),
      image: cleanImage(intro.image, 'Company introduction image'),
      stats: arr(intro.stats, MAX_ITEMS.stats, 'Statistics')
        .map((s) => ({ id: cleanId(obj(s).id), value: cleanText(obj(s).value, 40), label: cleanText(obj(s).label, LIMITS.short) }))
        .filter((s) => s.value || s.label)
        .map(unique),
      highlights: arr(intro.highlights, MAX_ITEMS.highlights, 'Highlights')
        .map((h) => cleanText(h, LIMITS.short))
        .filter(Boolean),
    },
    capabilities: {
      ...sectionHeader(caps),
      description: cleanText(caps.description),
      items: arr(caps.items, MAX_ITEMS.capabilities, 'Capabilities').map(sanitizeCapability).map(unique),
    },
    visionMission: {
      ...sectionHeader(vm),
      vision: panel(vm.vision, 'Vision'),
      mission: panel(vm.mission, 'Mission'),
    },
    pillars: {
      ...sectionHeader(pillars),
      description: cleanText(pillars.description),
      items: arr(pillars.items, MAX_ITEMS.pillars, 'Pillars').map(sanitizePillar).map(unique),
    },
    journey: {
      ...sectionHeader(journey),
      description: cleanText(journey.description),
      items: arr(journey.items, MAX_ITEMS.journey, 'Journey stages').map(sanitizeStage).map(unique),
    },
    cta: {
      heading: cleanText(finalCta.heading, LIMITS.heading),
      description: cleanText(finalCta.description),
      buttonLabel: cleanText(finalCta.buttonLabel, LIMITS.short),
      buttonUrl: cleanUrl(finalCta.buttonUrl, 'Call to action button'),
    },
  };
};

// Every image URL used in a content object (used to clean up replaced uploads)
export const collectImages = (c) => {
  if (!c) return [];
  return [
    c.hero?.image,
    c.intro?.image,
    c.visionMission?.vision?.image,
    c.visionMission?.mission?.image,
    ...(c.capabilities?.items || []).map((i) => i.image),
  ].filter(Boolean);
};
