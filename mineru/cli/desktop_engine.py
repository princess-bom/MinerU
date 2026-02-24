# Copyright (c) Opendatalab. All rights reserved.
import json
import multiprocessing as mp
import os
import signal
from datetime import datetime, timezone
from pathlib import Path
from queue import Empty
from typing import Mapping
from uuid import uuid4

import click

from mineru.utils.config_reader import get_device
from mineru.utils.guess_suffix_or_lang import guess_suffix_by_path
from mineru.utils.model_utils import get_vram

from ..version import __version__
from .common import do_parse, image_suffixes, pdf_suffixes, read_fn


EXIT_CODES = {
    "succeeded": 0,
    "failed": 1,
    "invalid_input": 2,
    "output_unwritable": 3,
    "cancelled": 4,
    "timeout": 5,
}

ERROR_CODES = {
    "invalid_input": "E_INVALID_INPUT",
    "engine_failed": "E_ENGINE_FAILED",
    "cancelled": "E_CANCELLED",
    "timeout": "E_TIMEOUT",
    "output_unwritable": "E_OUTPUT_UNWRITABLE",
}


class EngineContractError(Exception):
    pass


class InvalidInputError(EngineContractError):
    pass


class OutputUnwritableError(EngineContractError):
    pass


class TimeoutExceededError(EngineContractError):
    pass


def _utc_ts() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _emit_event(
    enabled: bool,
    *,
    event_type: str,
    job_id: str,
    stage: str,
    progress: int,
    message: str,
    error_code=None,
    payload=None,
):
    if not enabled:
        return
    event = {
        "type": event_type,
        "ts": _utc_ts(),
        "jobId": job_id,
        "stage": stage,
        "progress": progress,
        "message": message,
        "errorCode": error_code,
        "payload": payload if payload is not None else {},
    }
    click.echo(json.dumps(event), err=False)


def _collect_artifacts(output_dir: Path) -> dict[str, list[str]]:
    artifacts = {
        "markdown": [],
        "contentList": [],
        "middleJson": [],
        "modelJson": [],
    }
    if not output_dir.exists() or not output_dir.is_dir():
        return artifacts

    artifacts["markdown"] = sorted(str(path) for path in output_dir.rglob("*.md"))
    artifacts["contentList"] = sorted(
        str(path) for path in output_dir.rglob("*_content_list.json")
    )
    artifacts["middleJson"] = sorted(
        str(path) for path in output_dir.rglob("*_middle.json")
    )
    artifacts["modelJson"] = sorted(
        str(path) for path in output_dir.rglob("*_model.json")
    )
    return artifacts


def _set_runtime_env(backend: str, device_mode, virtual_vram, model_source: str):
    if backend.endswith("-client"):
        return

    if os.getenv("MINERU_DEVICE_MODE") is None:
        os.environ["MINERU_DEVICE_MODE"] = (
            device_mode if device_mode is not None else get_device()
        )

    if os.getenv("MINERU_VIRTUAL_VRAM_SIZE") is None:
        vram = (
            virtual_vram
            if virtual_vram is not None
            else get_vram(os.environ["MINERU_DEVICE_MODE"])
        )
        os.environ["MINERU_VIRTUAL_VRAM_SIZE"] = str(vram)

    if os.getenv("MINERU_MODEL_SOURCE") is None:
        os.environ["MINERU_MODEL_SOURCE"] = model_source


def _resolve_input_paths(input_path: Path) -> list[Path]:
    if not input_path.exists():
        raise InvalidInputError(f"Input does not exist: {input_path}")

    if input_path.is_dir():
        result = []
        for path in input_path.glob("*"):
            if guess_suffix_by_path(path) in pdf_suffixes + image_suffixes:
                result.append(path)
        if not result:
            raise InvalidInputError(f"No supported files found under: {input_path}")
        return result

    return [input_path]


def _ensure_output_dir(output_dir: Path):
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        test_file = output_dir / ".mineru-desktop-engine-write-test"
        test_file.write_text("ok", encoding="utf-8")
        test_file.unlink()
    except Exception as exc:
        raise OutputUnwritableError(
            f"Output dir is not writable: {output_dir}"
        ) from exc


def _write_result_manifest(output_dir: Path, manifest: Mapping[str, object]) -> bool:
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "result.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return True
    except Exception:
        return False


def _execute_parse(
    *,
    input_paths: list[Path],
    output_dir: Path,
    backend: str,
    method: str,
    lang: str,
    start_page_id: int,
    end_page_id,
    formula_enable: bool,
    table_enable: bool,
    device_mode,
    virtual_vram,
    model_source: str,
    server_url,
):
    _set_runtime_env(backend, device_mode, virtual_vram, model_source)
    file_name_list = [path.stem for path in input_paths]
    pdf_bytes_list = [read_fn(path) for path in input_paths]
    lang_list = [lang] * len(input_paths)
    do_parse(
        output_dir=str(output_dir),
        pdf_file_names=file_name_list,
        pdf_bytes_list=pdf_bytes_list,
        p_lang_list=lang_list,
        backend=backend,
        parse_method=method,
        formula_enable=formula_enable,
        table_enable=table_enable,
        server_url=server_url,
        start_page_id=start_page_id,
        end_page_id=end_page_id,
    )


def _parse_worker(
    input_paths: list[Path],
    output_dir: Path,
    backend: str,
    method: str,
    lang: str,
    start_page_id: int,
    end_page_id,
    formula_enable: bool,
    table_enable: bool,
    device_mode,
    virtual_vram,
    model_source: str,
    server_url,
    result_queue,
):
    try:
        _execute_parse(
            input_paths=input_paths,
            output_dir=output_dir,
            backend=backend,
            method=method,
            lang=lang,
            start_page_id=start_page_id,
            end_page_id=end_page_id,
            formula_enable=formula_enable,
            table_enable=table_enable,
            device_mode=device_mode,
            virtual_vram=virtual_vram,
            model_source=model_source,
            server_url=server_url,
        )
        result_queue.put({"ok": True})
    except Exception:
        result_queue.put({"ok": False, "errorCode": ERROR_CODES["engine_failed"]})


def _run_engine(
    *,
    input_path: str,
    output_dir: str,
    job_id: str,
    backend: str,
    method: str,
    lang: str,
    start_page_id: int,
    end_page_id,
    formula_enable: bool,
    table_enable: bool,
    device_mode,
    virtual_vram,
    model_source: str,
    timeout_ms,
    server_url,
    jsonl: bool,
) -> int:
    start_time = datetime.now(timezone.utc)
    input_path_obj = Path(input_path).expanduser().resolve()
    output_dir_path = Path(output_dir).expanduser().resolve()
    status = "failed"
    error_code = ERROR_CODES["engine_failed"]
    exit_code = EXIT_CODES["failed"]
    previous_sigterm_handler = None

    def _handle_sigterm(_signum, _frame):
        raise KeyboardInterrupt

    if hasattr(signal, "SIGTERM"):
        try:
            previous_sigterm_handler = signal.getsignal(signal.SIGTERM)
            signal.signal(signal.SIGTERM, _handle_sigterm)
        except (AttributeError, OSError, ValueError):
            previous_sigterm_handler = None

    _emit_event(
        jsonl,
        event_type="job.started",
        job_id=job_id,
        stage="starting",
        progress=0,
        message="Engine process started",
        error_code=None,
        payload={"backend": backend, "method": method},
    )

    try:
        try:
            if timeout_ms is not None and timeout_ms <= 0:
                raise InvalidInputError("timeoutMs must be greater than zero")
            if end_page_id is not None and start_page_id > end_page_id:
                raise InvalidInputError("start must be less than or equal to end")

            input_paths = _resolve_input_paths(input_path_obj)
            _ensure_output_dir(output_dir_path)

            _emit_event(
                jsonl,
                event_type="job.progress",
                job_id=job_id,
                stage="running",
                progress=10,
                message="Input validated",
                error_code=None,
                payload={"documents": len(input_paths)},
            )

            if timeout_ms is None:
                _execute_parse(
                    input_paths=input_paths,
                    output_dir=output_dir_path,
                    backend=backend,
                    method=method,
                    lang=lang,
                    start_page_id=start_page_id,
                    end_page_id=end_page_id,
                    formula_enable=formula_enable,
                    table_enable=table_enable,
                    device_mode=device_mode,
                    virtual_vram=virtual_vram,
                    model_source=model_source,
                    server_url=server_url,
                )
            else:
                ctx = mp.get_context("spawn")
                result_queue = ctx.Queue()
                worker = ctx.Process(
                    target=_parse_worker,
                    args=(
                        input_paths,
                        output_dir_path,
                        backend,
                        method,
                        lang,
                        start_page_id,
                        end_page_id,
                        formula_enable,
                        table_enable,
                        device_mode,
                        virtual_vram,
                        model_source,
                        server_url,
                        result_queue,
                    ),
                )
                worker.start()
                try:
                    worker.join(timeout_ms / 1000.0)
                    if worker.is_alive():
                        worker.terminate()
                        worker.join()
                        raise TimeoutExceededError("Timed out")

                    worker_result = {
                        "ok": False,
                        "errorCode": ERROR_CODES["engine_failed"],
                    }
                    try:
                        worker_result = result_queue.get_nowait()
                    except Empty:
                        pass

                    if not worker_result.get("ok"):
                        raise EngineContractError(
                            worker_result.get("errorCode", ERROR_CODES["engine_failed"])
                        )
                finally:
                    if worker.is_alive():
                        worker.terminate()
                        worker.join()
                    result_queue.close()
                    result_queue.join_thread()

            status = "succeeded"
            error_code = None
            exit_code = EXIT_CODES["succeeded"]
        except InvalidInputError:
            status = "failed"
            error_code = ERROR_CODES["invalid_input"]
            exit_code = EXIT_CODES["invalid_input"]
        except OutputUnwritableError:
            status = "failed"
            error_code = ERROR_CODES["output_unwritable"]
            exit_code = EXIT_CODES["output_unwritable"]
        except KeyboardInterrupt:
            status = "cancelled"
            error_code = ERROR_CODES["cancelled"]
            exit_code = EXIT_CODES["cancelled"]
        except TimeoutExceededError:
            status = "timeout"
            error_code = ERROR_CODES["timeout"]
            exit_code = EXIT_CODES["timeout"]
        except Exception:
            status = "failed"
            error_code = ERROR_CODES["engine_failed"]
            exit_code = EXIT_CODES["failed"]
    finally:
        if hasattr(signal, "SIGTERM") and previous_sigterm_handler is not None:
            try:
                signal.signal(signal.SIGTERM, previous_sigterm_handler)
            except (AttributeError, OSError, ValueError):
                pass

    end_time = datetime.now(timezone.utc)
    artifacts = (
        _collect_artifacts(output_dir_path)
        if status == "succeeded"
        else {"markdown": [], "contentList": [], "middleJson": [], "modelJson": []}
    )
    manifest = {
        "status": status,
        "errorCode": error_code,
        "outputDir": str(output_dir_path),
        "artifacts": artifacts,
        "engineVersion": __version__,
        "backend": backend,
        "method": method,
        "timings": {
            "startedAt": start_time.isoformat(timespec="milliseconds").replace(
                "+00:00", "Z"
            ),
            "endedAt": end_time.isoformat(timespec="milliseconds").replace(
                "+00:00", "Z"
            ),
            "durationMs": int((end_time - start_time).total_seconds() * 1000),
        },
    }

    manifest_written = _write_result_manifest(output_dir_path, manifest)
    if not manifest_written:
        status = "failed"
        error_code = ERROR_CODES["output_unwritable"]
        exit_code = EXIT_CODES["output_unwritable"]

    result_payload = {
        "resultPath": str(output_dir_path / "result.json") if manifest_written else None
    }
    if status == "succeeded":
        _emit_event(
            jsonl,
            event_type="job.succeeded",
            job_id=job_id,
            stage="completed",
            progress=100,
            message="Completed",
            error_code=None,
            payload=result_payload,
        )
    elif status == "cancelled":
        _emit_event(
            jsonl,
            event_type="job.cancelled",
            job_id=job_id,
            stage="cancelled",
            progress=100,
            message="Cancelled",
            error_code=error_code,
            payload=result_payload,
        )
    else:
        _emit_event(
            jsonl,
            event_type="job.failed",
            job_id=job_id,
            stage="failed",
            progress=100,
            message="Engine failed",
            error_code=error_code,
            payload=result_payload,
        )

    return exit_code


@click.command()
@click.option(
    "--input",
    "input_path",
    type=str,
    required=True,
    help="Input file path or directory",
)
@click.option(
    "--output", "output_dir", type=str, required=True, help="Output directory"
)
@click.option(
    "--job-id",
    type=str,
    default=lambda: str(uuid4()),
    show_default=False,
    help="Job identifier",
)
@click.option(
    "--backend",
    type=click.Choice(
        [
            "pipeline",
            "vlm-http-client",
            "hybrid-http-client",
            "vlm-auto-engine",
            "hybrid-auto-engine",
        ]
    ),
    default="pipeline",
    show_default=True,
    help="Parsing backend",
)
@click.option(
    "--method",
    type=click.Choice(["auto", "txt", "ocr"]),
    default="auto",
    show_default=True,
)
@click.option(
    "--lang",
    type=click.Choice(
        [
            "ch",
            "ch_server",
            "ch_lite",
            "en",
            "korean",
            "japan",
            "chinese_cht",
            "ta",
            "te",
            "ka",
            "th",
            "el",
            "latin",
            "arabic",
            "east_slavic",
            "cyrillic",
            "devanagari",
        ]
    ),
    default="ch",
    show_default=True,
)
@click.option(
    "--start",
    "start_page_id",
    type=int,
    default=0,
    show_default=True,
    help="Start page index",
)
@click.option("--end", "end_page_id", type=int, default=None, help="End page index")
@click.option("--formula", "formula_enable", type=bool, default=True, show_default=True)
@click.option("--table", "table_enable", type=bool, default=True, show_default=True)
@click.option("--device", "device_mode", type=str, default=None, help="Device override")
@click.option("--vram", "virtual_vram", type=int, default=None, help="VRAM override")
@click.option(
    "--source",
    "model_source",
    type=click.Choice(["huggingface", "modelscope", "local"]),
    default="huggingface",
    show_default=True,
)
@click.option(
    "--url",
    "server_url",
    type=str,
    default=None,
    help="Server URL for http-client backends",
)
@click.option("--timeout-ms", type=int, default=None, help="Timeout in milliseconds")
@click.option(
    "--jsonl/--no-jsonl",
    default=True,
    show_default=True,
    help="Enable JSONL progress events",
)
def main(**kwargs):
    raise SystemExit(_run_engine(**kwargs))


if __name__ == "__main__":
    main()
