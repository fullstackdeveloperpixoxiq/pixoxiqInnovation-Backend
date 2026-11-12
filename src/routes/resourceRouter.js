import { Router } from 'express';

// Standard protected CRUD router for a controller produced by crudFactory.
// `uploadMiddleware` (optional) runs before create/update to accept a file.
const resourceRouter = (controller, { uploadMiddleware } = {}) => {
  const router = Router();
  const withUpload = uploadMiddleware ? [uploadMiddleware] : [];

  router.route('/').get(controller.list).post(...withUpload, controller.create);
  router.patch('/reorder', controller.reorder);
  router.route('/:id').get(controller.getOne).put(...withUpload, controller.update).delete(controller.remove);
  router.patch('/:id/toggle', controller.toggleActive);

  return router;
};

export default resourceRouter;
