"""远程训练运行时:results.csv 镜像与进度同步的回归。

历史上的教训:_mirror_results_csv 引用了未定义的 _POLL_TIMEOUT,NameError 被
轮询循环兜底吞掉,导致所有远程训练的进度/指标全程冻结。这里的用例保证
镜像函数可被真实调用且落盘,同类笔误会在测试里直接炸出来。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.models import TrainingTask
from app.training.runtime import remote_training as rt


class _FakeResponse:
    def __init__(self, status_code: int = 200, text: str = "") -> None:
        self.status_code = status_code
        self.text = text


@pytest.fixture()
def task(tmp_path: Path) -> TrainingTask:
    return TrainingTask(
        id="train-mirror-test",
        dataset_id="ds-1",
        name="mirror",
        status="running",
        task_type="detect",
        model_name="yolov8n.pt",
        model_path="yolov8n.pt",
        epochs=10,
        img_size=640,
        batch_size=4,
        device="0",
        workers=2,
        val_ratio=0.2,
        seed=42,
        run_dir=str(tmp_path / "run"),
    )


def test_mirror_results_csv_writes_file(tmp_path: Path, task: TrainingTask, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    def fake_get(url: str, headers: dict | None = None, timeout: float | None = None) -> _FakeResponse:
        captured["url"] = url
        return _FakeResponse(text="epoch,train/loss\n1,2.5\n2,2.1\n")

    monkeypatch.setattr(rt.httpx, "get", fake_get)
    rt._mirror_results_csv({"url": "http://agent.test:8010", "token": "123"}, task)

    assert "tasks/train-mirror-test/artifacts/results.csv" in captured["url"]
    mirrored = Path(task.run_dir) / "results.csv"
    assert mirrored.is_file()
    assert mirrored.read_text(encoding="utf-8").startswith("epoch,train/loss")


def test_mirror_results_csv_swallows_fetch_errors(tmp_path: Path, task: TrainingTask, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken_get(url: str, **_: object) -> _FakeResponse:
        raise RuntimeError("agent unreachable")

    monkeypatch.setattr(rt.httpx, "get", broken_get)
    rt._mirror_results_csv({"url": "http://agent.test:8010", "token": "123"}, task)  # 不应抛出
    assert not (Path(task.run_dir) / "results.csv").exists()

    # 非 200 也不落盘
    monkeypatch.setattr(rt.httpx, "get", lambda *_, **__: _FakeResponse(status_code=404))
    rt._mirror_results_csv({"url": "http://agent.test:8010", "token": "123"}, task)
    assert not (Path(task.run_dir) / "results.csv").exists()


def test_agent_progress_regex_parses_ansi_epoch_lines() -> None:
    """agent 侧 epoch 正则要能匹配 tqdm 的 ANSI 转义前缀行(用真实 agent.py 验证)。"""
    import importlib.util

    agent_path = Path(__file__).resolve().parents[2] / "compute-agent" / "agent.py"
    spec = importlib.util.spec_from_file_location("compute_agent_under_test", agent_path)
    agent = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(agent)

    line = "\x1b[K     24/500      2.37G      1.059     0.7809     0.8239"
    match = agent._EPOCH_LINE.match(agent._ANSI_ESCAPE.sub("", line))
    assert match is not None
    assert (match.group(1), match.group(2)) == ("24", "500")
