from enum import StrEnum


class TaskType(StrEnum):
    DETECT = "detect"
    SEGMENT = "segment"
    OBB = "obb"
    CLASSIFY = "classify"
    POSE = "pose"


def annotation_type_for(task_type: TaskType | str) -> str:
    resolved = TaskType(task_type)
    return {
        TaskType.DETECT: "bbox",
        TaskType.SEGMENT: "polygon",
        TaskType.OBB: "obb",
        TaskType.CLASSIFY: "classify",
        TaskType.POSE: "pose",
    }[resolved]
