// Builds a paginated, searchable, filterable Mongo query from request query params.
// Supported params: page, limit, search, sort (e.g. "-createdAt" or "order"), plus any
// key listed in `filterFields` (e.g. ?status=new&isActive=true).

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseValue = (value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

export const buildListQuery = (query, { searchFields = [], filterFields = [], defaultSort = '-createdAt' } = {}) => {
  const filter = {};

  filterFields.forEach((field) => {
    const value = query[field];
    // Only plain strings: blocks operator injection like ?status[$ne]=x
    if (typeof value === 'string' && value !== '' && value !== 'all') filter[field] = parseValue(value);
  });

  if (typeof query.search === 'string' && query.search.trim() && searchFields.length) {
    const regex = new RegExp(escapeRegex(String(query.search).trim()), 'i');
    filter.$or = searchFields.map((field) => ({ [field]: regex }));
  }

  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  const sort = typeof query.sort === 'string' && /^-?[\w.]+$/.test(query.sort) ? query.sort : defaultSort;

  return { filter, page, limit, skip: (page - 1) * limit, sort };
};

export const paginate = async (Model, query, options) => {
  const { filter, page, limit, skip, sort } = buildListQuery(query, options);
  let find = Model.find(filter).sort(sort).skip(skip).limit(limit);
  if (options?.populate) find = find.populate(options.populate);
  const [items, total] = await Promise.all([
    find,
    Model.countDocuments(filter),
  ]);
  return {
    items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  };
};
