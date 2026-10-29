from fastapi import APIRouter

from app.api.routers import class_templates, datasets, ftp, models, sam, settings, system, training, weights
from app.tag_library.router import router as tag_library_router
from app.material_type.router import router as material_type_router
from app.source_dataset.router import router as source_dataset_router
from app.agent.router import router as agent_router
from app.auto_annotation.router import dataset_router as auto_annotation_dataset_router, task_router as auto_annotation_task_router
from app.logs.router import router as logs_router
from app.plugins.router import router as plugins_router
from app.video_import.router import router as video_import_router

api_router = APIRouter(prefix="/api")
api_router.include_router(system.router)
api_router.include_router(class_templates.router)
api_router.include_router(datasets.router)
api_router.include_router(datasets.file_router)
api_router.include_router(training.router)
api_router.include_router(models.router)
api_router.include_router(models.om_router)
api_router.include_router(sam.router)
api_router.include_router(settings.router)
api_router.include_router(ftp.router)
api_router.include_router(source_dataset_router)
api_router.include_router(logs_router)
api_router.include_router(plugins_router)
api_router.include_router(auto_annotation_dataset_router)
api_router.include_router(auto_annotation_task_router)
api_router.include_router(video_import_router)
api_router.include_router(agent_router)
api_router.include_router(weights.router)
api_router.include_router(tag_library_router)
api_router.include_router(material_type_router)
