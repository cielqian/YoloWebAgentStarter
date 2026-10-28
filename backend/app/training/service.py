from __future__ import annotations

import re
import shlex
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.ids import new_id
from app.core.models import ClassLabel, Dataset, ImageItem, TrainingProfile, TrainingTask
from app.core.storage import Storage
from app.core.task_types import TaskType
from app.dataset.exchange.yolo import export_dataset_directory
from app.dataset.service import get_dataset
from app.dataset.validation import validate_dataset
from app.training.artifacts.checkpoints import checkpoint_paths
from app.training.config import build_training_command, resolve_model_reference, validate_model_family
from app.training.observability.log_store import TrainingLogStore
from app.training.observability.summary import write_training_summary
from app.training.observability.telemetry import TrainingTelemetryService
from app.training.runtime.process_registry import process_registry
from app.training.runtime.queue import TrainingQueue
from app.training.runtime.device_service import DeviceService
from app.training.runtime.remote_nodes import RemoteNodeUnavailable, fetch_node_snapshot
from app.training.runtime.remote_training import (
    RemoteTrainingError,
    delete_remote_task,
    dispatch_remote_task,
    find_node,
    parse_remote_device_set,
    remote_node_occupied_devices,
    stop_remote_task,
)
from app.training.webhooks import notify_training_status

if TYPE_CHECKING:
    from app.core.config import Settings
from app.training.schemas import (
    TrainingLogResponse,
    TrainingProfileCreate,
    TrainingProfileUpdate,
    TrainingProfileResponse,
    TrainingSummaryResponse,
    TrainingTaskCreate,
    TrainingTaskList,
    TrainingTaskResponse,
    TrainingTaskResumeRequest,
)


class TrainingService:
    def __init__(self, session_factory: sessionmaker[Session], storage: Storage, queue: TrainingQueue) -> None:
        self.session_factory = session_factory
        self.storage = storage
        self.queue = queue
        self.queue.configure(session_factory, storage)

    def create_task(
        self,
        session: Session,
        payload: TrainingTaskCreate,
        *,
        task_id: str | None = None,
        settings: "Settings | None" = None,
    ) -> TrainingTaskResponse:
        return self._create_task(session, payload, task_id=task_id, settings=settings)

    def devices(self) -> list[dict[str, object]]:
        return [device.as_dict() for device in DeviceService().list_devices()]

    def resume_task(
        self,
        session: Session,
        task_id: str,
        payload: TrainingTaskResumeRequest,
        *,
        settings: "Settings | None" = None,
    ) -> TrainingTaskResponse:
        previous = self.get_task(session, task_id)
        if previous.status not in {"completed", "failed", "stopped"}:
            raise ValidationError("resume_task_not_finished", "Only completed, failed, or stopped training tasks can be resumed.")
        if payload.resume_epoch and previous.status == "completed":
            raise ValidationError(
                "resume_completed_task",
                "A completed task cannot restore epoch state; start a new task from last.pt with resume_epoch=false.",
            )
        if payload.resume_epoch and payload.epochs is not None and payload.epochs != previous.epochs:
            raise ValidationError(
                "resume_epochs_fixed",
                "Epoch-state resume keeps the source task's total epochs; use resume_epoch=false to train additional epochs.",
            )
        if payload.resume_epoch and previous.node_id:
            raise ValidationError(
                "remote_resume_epoch_unsupported",
                "Remote tasks cannot restore epoch state; resume from last.pt with resume_epoch=false instead.",
            )
        checkpoint = checkpoint_paths(previous.run_dir or "").get("last")
        if checkpoint is None:
            raise NotFoundError("resume_checkpoint_not_found", "This training task has no managed last.pt checkpoint.")
        source_run_dir = self.storage.managed_training_path(previous.run_dir or "")
        source_checkpoint = self.storage.managed_training_path(checkpoint)
        if not source_run_dir.is_dir() or not source_checkpoint.is_file():
            raise NotFoundError("resume_checkpoint_not_found", "This training task has no managed last.pt checkpoint.")
        source_config = dict(previous.config_json or {})
        source_config["name"] = (payload.name or f"{previous.name} (resume)").strip()
        if payload.epochs is not None and not payload.resume_epoch:
            source_config["epochs"] = payload.epochs
        task_payload = TrainingTaskCreate.model_validate(source_config)
        return self._create_task(
            session,
            task_payload,
            resume_checkpoint=source_checkpoint,
            resume_run_dir=source_run_dir if payload.resume_epoch else None,
            resume_epoch=payload.resume_epoch,
            resume_source_task_id=previous.id,
            settings=settings,
        )

    def _create_task(
        self,
        session: Session,
        payload: TrainingTaskCreate,
        *,
        task_id: str | None = None,
        resume_checkpoint: Path | None = None,
        resume_run_dir: Path | None = None,
        resume_epoch: bool = False,
        resume_source_task_id: str | None = None,
        settings: "Settings | None" = None,
    ) -> TrainingTaskResponse:
        node = self._resolve_remote_node(payload, settings)
        if node is None:
            payload.device = DeviceService().normalize_selector(payload.device)
        dataset = get_dataset(session, payload.dataset_id)
        dataset_version_number = resolve_dataset_version(session, dataset.id, payload.dataset_version_number)
        include_unannotated = bool(payload.include_unannotated)
        task_type = payload.task_type or TaskType(dataset.task_type)
        if task_type.value != dataset.task_type:
            raise ValidationError("task_type_mismatch", "Training task type must match the dataset task type.")
        validate_model_family(task_type, payload.model)
        model_reference = resolve_model_reference(payload.model, self.storage)
        self._validate_dataset_ready(session, dataset)

        if task_id:
            existing = session.get(TrainingTask, task_id)
            if existing is not None:
                return task_response(existing)
        if node is not None and not resume_epoch:
            return self._create_remote_task_async(
                session, payload, node, dataset, task_type, settings,
                task_id=task_id, resume_checkpoint=resume_checkpoint,
            )
        resolved_task_id = task_id or new_id("train")
        task_root = self.storage.training_task_dir(resolved_task_id)
        export_root = task_root / "dataset"
        run_dir = resume_run_dir if resume_run_dir is not None else task_root / "run"
        dataset_zip: Path | None = None
        weights_path: Path | None = None
        try:
            if resume_checkpoint is not None:
                model_reference = str(resume_checkpoint)
            export = export_training_data(session, self.storage, dataset, dataset_version_number, export_root, include_unannotated=include_unannotated)
            self._validate_export_training_splits(export, dataset.task_type, payload.device, include_unannotated=include_unannotated)
            data_yaml = str(export["data_yaml"])
            export_stats = {
                key: export.get(key)
                for key in (
                    "counts",
                    "annotated_image_counts",
                    "total_image_counts",
                    "skipped_image_counts",
                    "label_count",
                )
            }
            if node is not None:
                command_args, dataset_zip, weights_path = self._prepare_remote_dispatch(
                    resolved_task_id, payload, task_type, model_reference, export_root
                )
                command_preview = shlex.join(command_args)
            else:
                command = build_training_command(
                task_type=task_type,
                model=model_reference,
                data_yaml=data_yaml,
                run_dir=str(run_dir),
                epochs=payload.epochs,
                img_size=payload.img_size,
                batch_size=payload.batch_size,
                device=payload.device,
                workers=payload.workers,
                seed=payload.seed,
                optimizer=payload.optimizer,
                lr0=payload.lr0,
                patience=payload.patience,
                hsv_h=payload.hsv_h,
                degrees=payload.degrees,
                mixup=payload.mixup,
                fliplr=payload.fliplr,
                resume=resume_epoch,
            )
                command_args = command.args
                command_preview = command.readable
            task = TrainingTask(
                id=resolved_task_id,
                dataset_id=dataset.id,
                dataset_version_number=dataset_version_number,
                include_unannotated=include_unannotated,
                name=payload.name.strip(),
                status="pending",
                task_type=task_type.value,
                model_name=payload.model,
                model_path=model_reference,
                epochs=payload.epochs,
                img_size=payload.img_size,
                batch_size=payload.batch_size,
                device=payload.device,
                node_id=node["id"] if node is not None else None,
                workers=payload.workers,
                val_ratio=payload.val_ratio,
                seed=payload.seed,
                optimizer=payload.optimizer,
                lr0=payload.lr0,
                patience=payload.patience,
                hsv_h=payload.hsv_h,
                degrees=payload.degrees,
                mixup=payload.mixup,
                fliplr=payload.fliplr,
                config_json={
                    **payload.model_dump(),
                    **({"resume_source_task_id": resume_source_task_id, "resume_epoch": resume_epoch} if resume_source_task_id else {}),
                },
                command_args_json=command_args,
                command_preview=command_preview,
                export_path=str(export["root"]),
                data_yaml_path=data_yaml,
                export_stats_json=export_stats,
                run_dir=str(run_dir),
                logs_path=str(task_root / "train.log"),
                summary_path=str(task_root / "training_summary.json"),
                progress_total_epochs=payload.epochs,
            )
            session.add(task)
            session.commit()
            session.refresh(task)
        except Exception:
            session.rollback()
            self.storage.remove_training_task(resolved_task_id)
            raise
        if node is not None:
            return self._submit_remote_task(session, task, node, dataset_zip, weights_path)
        self.queue.submit(resolved_task_id)
        return task_response(task)

    def _resolve_remote_node(self, payload: TrainingTaskCreate, settings: "Settings | None") -> dict | None:
        if not payload.node_id:
            return None
        if settings is None:
            raise ValidationError(
                "training_node_settings_missing",
                "Remote training requires backend settings; start the task from the training page.",
            )
        node = find_node(settings, payload.node_id)
        if node is None or not node.get("enabled", True):
            raise ValidationError("training_node_not_found", "Training node was not found or is disabled.")
        try:
            snapshot = fetch_node_snapshot(str(node.get("url") or ""), str(node.get("token") or ""))
        except RemoteNodeUnavailable as exc:
            raise ValidationError("training_node_unreachable", f"Training node is not reachable: {exc}") from exc
        selector = payload.device.strip()
        if selector != "auto":
            available = sorted(
                str(item.get("id"))
                for item in snapshot["payload"].get("devices", [])
                if isinstance(item, dict) and item.get("id")
            )
            requested = [part.strip() for part in selector.split(",") if part.strip()]
            missing = [part for part in requested if part not in available]
            if not requested or missing:
                raise ValidationError(
                    "training_device_unavailable",
                    f"The node does not expose device(s) {', '.join(missing) or selector}.",
                    details={"available_devices": available},
                )
        return node

    def _prepare_remote_dispatch(
        self,
        task_id: str,
        payload: TrainingTaskCreate,
        task_type: TaskType,
        model_reference: str,
        export_root: Path,
    ) -> tuple[list[str], Path, Path | None]:
        archive = self.storage.tmp_dir / f"{task_id}-dataset.zip"
        archive.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for item in sorted(export_root.rglob("*")):
                if item.is_file():
                    zf.write(item, item.relative_to(export_root).as_posix())
        weights_path = Path(model_reference) if Path(model_reference).is_absolute() else None
        model_arg = weights_path.name if weights_path is not None else payload.model
        args = [
            "yolo",
            task_type.value,
            "train",
            f"model={model_arg}",
            "data=dataset/data.yaml",
            f"epochs={payload.epochs}",
            f"imgsz={payload.img_size}",
            f"batch={payload.batch_size}",
            "project=.",
            "name=run",
            "exist_ok=True",
            f"workers={payload.workers}",
            f"seed={payload.seed}",
        ]
        if payload.device != "auto":
            args.append(f"device={payload.device}")
        if payload.optimizer:
            args.append(f"optimizer={payload.optimizer}")
        if payload.lr0 is not None:
            args.append(f"lr0={payload.lr0}")
        if payload.patience is not None:
            args.append(f"patience={payload.patience}")
        return args, archive, weights_path

    def _create_remote_task_async(
        self,
        session: Session,
        payload: TrainingTaskCreate,
        node: dict,
        dataset: Dataset,
        task_type: TaskType,
        settings: "Settings | None",
        *,
        task_id: str | None = None,
        resume_checkpoint: Path | None = None,
    ) -> TrainingTaskResponse:
        """远程任务：同步只做校验与建行（dispatching），导出/打包/上传全部后台执行。"""
        from app.training.runtime.remote_training import start_remote_dispatch

        if settings is None:
            raise ValidationError(
                "training_node_settings_missing",
                "Remote training requires backend settings; start the task from the training page.",
            )
        resolved_task_id = task_id or new_id("train")
        task_root = self.storage.training_task_dir(resolved_task_id)
        model_arg = Path(payload.model).name if Path(payload.model).is_absolute() else payload.model
        args = [
            "yolo",
            task_type.value,
            "train",
            f"model={model_arg}",
            "data=dataset/data.yaml",
            f"epochs={payload.epochs}",
            f"imgsz={payload.img_size}",
            f"batch={payload.batch_size}",
            "project=.",
            "name=run",
            "exist_ok=True",
            f"workers={payload.workers}",
            f"seed={payload.seed}",
        ]
        if payload.device != "auto":
            args.append(f"device={payload.device}")
        if payload.optimizer:
            args.append(f"optimizer={payload.optimizer}")
        if payload.lr0 is not None:
            args.append(f"lr0={payload.lr0}")
        if payload.patience is not None:
            args.append(f"patience={payload.patience}")
        for key in ("hsv_h", "degrees", "mixup", "fliplr"):
            value = getattr(payload, key)
            if value is not None:
                args.append(f"{key}={value}")
        task = TrainingTask(
            id=resolved_task_id,
            dataset_id=dataset.id,
            dataset_version_number=resolve_dataset_version(session, dataset.id, payload.dataset_version_number),
            include_unannotated=bool(payload.include_unannotated),
            name=payload.name.strip(),
            status="dispatching",
            task_type=task_type.value,
            model_name=payload.model,
            model_path=str(resume_checkpoint) if resume_checkpoint is not None else resolve_model_reference(payload.model, self.storage),
            epochs=payload.epochs,
            img_size=payload.img_size,
            batch_size=payload.batch_size,
            device=payload.device,
            node_id=node["id"],
            workers=payload.workers,
            val_ratio=payload.val_ratio,
            seed=payload.seed,
            optimizer=payload.optimizer,
            lr0=payload.lr0,
            patience=payload.patience,
            hsv_h=payload.hsv_h,
            degrees=payload.degrees,
            mixup=payload.mixup,
            fliplr=payload.fliplr,
            config_json=dict(payload.model_dump()),
            command_args_json=args,
            command_preview=shlex.join(args),
            run_dir=str(task_root / "run"),
            logs_path=str(task_root / "train.log"),
            summary_path=str(task_root / "training_summary.json"),
            progress_total_epochs=payload.epochs,
            progress_percent=0.0,
        )
        session.add(task)
        session.commit()
        session.refresh(task)
        start_remote_dispatch(self.session_factory, self.storage, settings, task.id)
        return task_response(task)

    def _submit_remote_task(
        self,
        session: Session,
        task: TrainingTask,
        node: dict,
        dataset_zip: Path | None,
        weights_path: Path | None,
    ) -> TrainingTaskResponse:
        # 显卡不再做忙碌限制：任务可直接选择任意显卡，与其他任务并行使用
        return self._dispatch_remote_task(session, task, node, dataset_zip, weights_path)

    def _dispatch_remote_task(
        self,
        session: Session,
        task: TrainingTask,
        node: dict,
        dataset_zip: Path | None,
        weights_path: Path | None,
    ) -> TrainingTaskResponse:
        model_arg = Path(task.model_path).name if Path(task.model_path).is_absolute() else task.model_name
        spec = {
            "task_id": task.id,
            "task_type": task.task_type,
            "model": model_arg,
            "epochs": task.epochs,
            "img_size": task.img_size,
            "batch_size": task.batch_size,
            "device": task.device,
            "workers": task.workers,
            "seed": task.seed,
            "optimizer": task.optimizer,
            "lr0": task.lr0,
            "patience": task.patience,
        }
        try:
            if dataset_zip is None:
                raise RemoteTrainingError("dataset archive was not prepared.")
            dispatch_remote_task(node, spec, dataset_zip, weights_path)
        except RemoteTrainingError as exc:
            session.delete(task)
            session.commit()
            self.storage.remove_training_task(task.id)
            raise ValidationError("remote_dispatch_failed", str(exc)) from exc
        finally:
            if dataset_zip is not None:
                dataset_zip.unlink(missing_ok=True)
        from app.core.time import utc_now

        task.status = "running"
        task.started_at = utc_now()
        task.progress_total_epochs = task.epochs
        session.commit()
        session.refresh(task)
        notify_training_status("running", task)
        TrainingLogStore(task.logs_path or "train.log").append(
            f"Remote training dispatched to node {node.get('name')} ({node.get('url')})."
        )
        return task_response(task)

    def list_tasks(self, session: Session, dataset_id: str | None = None, dataset_version: int | None = None) -> TrainingTaskList:
        query = select(TrainingTask).order_by(TrainingTask.created_at.desc(), TrainingTask.id.desc())
        if dataset_id:
            query = query.where(TrainingTask.dataset_id == dataset_id)
        if dataset_version is not None:
            query = query.where(TrainingTask.dataset_version_number == dataset_version)
        tasks = list(session.scalars(query))
        telemetry = TrainingTelemetryService()
        for task in tasks:
            telemetry.refresh_task(session, task)
        return TrainingTaskList(items=[task_response(task) for task in tasks])

    def get_task(self, session: Session, task_id: str) -> TrainingTask:
        task = session.get(TrainingTask, task_id)
        if task is None:
            raise NotFoundError("training_task_not_found", "Training task was not found.")
        return task

    def get_task_response(self, session: Session, task_id: str) -> TrainingTaskResponse:
        task = self.get_task(session, task_id)
        return task_response(TrainingTelemetryService().refresh_task(session, task))

    def stop_task(self, session: Session, task_id: str, *, settings: "Settings | None" = None) -> TrainingTaskResponse:
        task = self.get_task(session, task_id)
        if task.status in {"completed", "failed", "stopped"}:
            return task_response(task)
        if task.node_id:
            node = find_node(settings, task.node_id) if settings is not None else None
            if task.status == "dispatching":
                task.stop_requested = True
                session.commit()
                session.refresh(task)
                return task_response(task)
            if task.status == "pending":
                if node is not None:
                    delete_remote_task(node, task.id)
                task.status = "stopped"
                task.error_message = "Training stopped before it started."
                from app.core.time import utc_now

                task.finished_at = utc_now()
                session.commit()
                notify_training_status("stopped", task)
                return task_response(task)
            task.stop_requested = True
            session.commit()
            if node is not None:
                stop_remote_task(node, task.id)
            session.refresh(task)
            return task_response(task)
        if task.status == "pending":
            task.status = "stopped"
            task.error_message = "Training stopped before it started."
            from app.core.time import utc_now

            task.finished_at = utc_now()
            session.commit()
            self.queue.stop_pending(task_id)
            notify_training_status("stopped", task)
            return task_response(task)
        task.stop_requested = True
        session.commit()
        process_registry.request_stop(task_id)
        session.refresh(task)
        return task_response(task)

    def delete_task(self, session: Session, task_id: str, *, settings: "Settings | None" = None) -> None:
        task = self.get_task(session, task_id)
        if task.status == "running":
            raise ValidationError("training_task_running", "Stop the training task before deleting it.")
        if task.status == "pending" and task.node_id and settings is not None:
            node = find_node(settings, task.node_id)
            if node is not None:
                delete_remote_task(node, task.id)
        # 已注册模型是独立受管产物，保留；仅解除与训练记录的关联。
        for model in list(task.model_versions):
            model.training_task_id = None
        session.delete(task)
        session.commit()
        self.storage.remove_training_task(task_id)

    def logs(self, session: Session, task_id: str, tail: int = 200) -> TrainingLogResponse:
        task = self.get_task(session, task_id)
        store = TrainingLogStore(task.logs_path or "train.log")
        return TrainingLogResponse(task_id=task_id, logs=store.read(tail), line_count=store.line_count())

    def summary(self, session: Session, task_id: str) -> TrainingSummaryResponse:
        task = TrainingTelemetryService().refresh_task(session, self.get_task(session, task_id))
        store = TrainingLogStore(task.logs_path or "train.log")
        if task.status in {"completed", "failed", "stopped"} and task.summary_path and Path(task.summary_path).is_file():
            import json

            try:
                data = json.loads(Path(task.summary_path).read_text(encoding="utf-8"))
                return TrainingSummaryResponse.model_validate(data)
            except (OSError, ValueError):
                pass
        data = write_training_summary(task, task.dataset)
        data["log_summary"]["line_count"] = store.line_count()
        return TrainingSummaryResponse.model_validate(data)

    def checkpoint(self, session: Session, task_id: str, name: str) -> Path:
        task = self.get_task(session, task_id)
        if name not in {"best", "last"}:
            raise ValidationError("invalid_checkpoint", "Checkpoint must be best or last.")
        paths = checkpoint_paths(task.run_dir or "")
        path = paths[name]
        if path is None:
            raise NotFoundError("checkpoint_not_found", f"The {name}.pt checkpoint is not available.")
        return Path(path)

    def log_file(self, session: Session, task_id: str) -> tuple[Path, str]:
        """完整训练日志文件路径 + 下载文件名(本地与远程任务的平台侧镜像日志)。"""
        task = self.get_task(session, task_id)
        if not task.logs_path:
            raise NotFoundError("training_log_not_found", "该任务没有日志文件。")
        path = Path(task.logs_path)
        if not path.is_file():
            raise NotFoundError("training_log_not_found", "该任务的日志文件不存在。")
        safe_name = re.sub(r"[^\w一-鿿-]+", "_", task.name).strip("_") or task_id
        return path, f"{safe_name}_train.log"

    def create_profile(self, session: Session, payload: TrainingProfileCreate) -> TrainingProfileResponse:
        dataset = get_dataset(session, payload.dataset_id)
        if dataset.task_type != payload.task_type.value:
            raise ValidationError("task_type_mismatch", "Training profile type must match the dataset task type.")
        validate_model_family(payload.task_type, payload.model)
        profile = TrainingProfile(
            id=new_id("profile"),
            dataset_id=dataset.id,
            name=payload.name.strip(),
            description=payload.description,
            model_name=payload.model,
            task_type=payload.task_type.value,
            device=DeviceService().normalize_selector(payload.device),
            **payload.model_dump(exclude={"dataset_id", "name", "description", "model", "task_type", "device"}),
        )
        session.add(profile)
        try:
            session.commit()
        except IntegrityError as exc:
            session.rollback()
            raise ConflictError("training_profile_create_failed", "Training profile could not be saved.") from exc
        session.refresh(profile)
        return TrainingProfileResponse.model_validate(profile)

    def list_profiles(self, session: Session, dataset_id: str | None = None) -> list[TrainingProfileResponse]:
        query = select(TrainingProfile).order_by(TrainingProfile.created_at.desc())
        if dataset_id:
            query = query.where(TrainingProfile.dataset_id == dataset_id)
        return [TrainingProfileResponse.model_validate(item) for item in session.scalars(query)]

    def update_profile(self, session: Session, profile_id: str, payload: TrainingProfileUpdate) -> TrainingProfileResponse:
        profile = session.get(TrainingProfile, profile_id)
        if profile is None:
            raise NotFoundError("training_profile_not_found", "Training profile was not found.")
        changes = payload.model_dump(exclude_unset=True)
        if "device" in changes and changes["device"] is not None:
            changes["device"] = DeviceService().normalize_selector(changes["device"])
        if "task_type" in changes and changes["task_type"].value != profile.dataset.task_type:
            raise ValidationError("task_type_mismatch", "Training profile type must match the dataset task type.")
        if "model" in changes:
            validate_model_family(payload.task_type or TaskType(profile.task_type), changes["model"])
            changes["model_name"] = changes.pop("model")
        for field, value in changes.items():
            setattr(profile, field, value.value if isinstance(value, TaskType) else value)
        session.commit()
        session.refresh(profile)
        return TrainingProfileResponse.model_validate(profile)

    def _validate_dataset_ready(self, session: Session, dataset: Dataset) -> None:
        report = validate_dataset(session, self.storage, dataset.id)
        if not report.valid:
            raise ValidationError(
                "dataset_not_ready",
                "Dataset validation must pass before training starts.",
                details={"issues": [item.model_dump() for item in report.issues if item.level == "error"]},
            )
        split_counts = dict(
            session.execute(
                select(ImageItem.split, func.count(ImageItem.id)).where(ImageItem.dataset_id == dataset.id).group_by(ImageItem.split)
            ).all()
        )
        if not split_counts.get("train") or not split_counts.get("val"):
            raise ValidationError("training_split_missing", "Training requires at least one train image and one val image.")
        class_count = session.scalar(select(func.count()).select_from(ClassLabel).where(ClassLabel.dataset_id == dataset.id)) or 0
        if not class_count:
            raise ValidationError("training_classes_missing", "Training requires at least one class label.")

    @staticmethod
    def _validate_export_training_splits(export: dict[str, object], task_type: str, device: str | None = None, include_unannotated: bool = False) -> None:
        annotated_image_counts = dict(export.get("annotated_image_counts") or {})
        if include_unannotated:
            # 未标注图片以空标签参与训练/验证,门槛按总图片数评估
            annotated_image_counts = dict(export.get("total_image_counts") or {})
        if device:
            from app.training.runtime.remote_training import parse_remote_device_set

            world = len(parse_remote_device_set(device) or set())
            val_annotated = int(annotated_image_counts.get("val") or 0)
            if world > 1 and val_annotated < 2 * world:
                raise ValidationError(
                    "multi_gpu_val_too_small",
                    f"{world} 卡 DDP 训练要求验证集已标注图片数至少为卡数的 2 倍（当前 {val_annotated} 张）。"
                    "数据太少会触发 ultralytics 上游崩溃，请先标注更多图片后重试。",
                )
        missing = [split for split in ("train", "val") if not annotated_image_counts.get(split)]
        if missing:
            if task_type == TaskType.CLASSIFY:
                raise ValidationError(
                    "training_classification_split_unannotated",
                    "Classification training requires at least one annotated image in both train and val splits.",
                    details={"missing_splits": missing},
                )
            raise ValidationError(
                "training_split_unannotated",
                "Training requires at least one valid annotation in both train and val splits.",
                details={"missing_splits": missing},
            )


def resolve_dataset_version(session: Session, dataset_id: str, requested: int | None) -> int | None:
    """训练使用的数据集版本：未指定时默认最新版本；数据集尚无版本时为 None。"""
    from app.core.models import DatasetVersion

    latest = session.scalar(
        select(func.max(DatasetVersion.version_number)).where(DatasetVersion.dataset_id == dataset_id)
    )
    if latest is None:
        if requested is not None:
            from app.core.errors import NotFoundError
            from app.dataset.versions import get_version_by_number

            get_version_by_number(session, dataset_id, requested)
        return None
    if requested is None:
        return latest
    from app.dataset.versions import get_version_by_number

    get_version_by_number(session, dataset_id, requested)
    return requested


def export_training_data(
    session: Session,
    storage: Storage,
    dataset: Dataset,
    dataset_version_number: int | None,
    export_root: Path,
    *,
    include_unannotated: bool = False,
) -> dict[str, object]:
    """训练数据导出：激活版本（或无版本）走当前工作区，历史版本走快照导出。"""
    from app.dataset.exchange.yolo import export_dataset_directory, export_dataset_version_directory

    if dataset_version_number is None:
        return export_dataset_directory(session, storage, dataset.id, export_root, include_unannotated=include_unannotated)
    from app.core.models import DatasetVersion

    active = session.scalar(
        select(DatasetVersion.version_number).where(
            DatasetVersion.dataset_id == dataset.id, DatasetVersion.is_active.is_(True)
        )
    )
    if active == dataset_version_number:
        return export_dataset_directory(session, storage, dataset.id, export_root, include_unannotated=include_unannotated)
    return export_dataset_version_directory(session, storage, dataset.id, dataset_version_number, export_root, include_unannotated=include_unannotated)


def task_response(task: TrainingTask) -> TrainingTaskResponse:
    return TrainingTaskResponse.model_validate(task)
