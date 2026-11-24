// Tracks changes to website content the AI assistant reads live (services, certificates,
// vacancies, visiting card). Models register `trackChanges(schema)`; any write bumps the
// version so the assistant's company-data cache reloads on the next question.

let version = 1;

export const companyDataVersion = () => version;
export const markCompanyDataChanged = () => {
  version += 1;
};

const WRITE_HOOKS = [
  'save',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'findOneAndUpdate',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'replaceOne',
  'insertMany',
  'bulkWrite',
];

export const trackChanges = (schema) => {
  WRITE_HOOKS.forEach((hook) => schema.post(hook, markCompanyDataChanged));
};
