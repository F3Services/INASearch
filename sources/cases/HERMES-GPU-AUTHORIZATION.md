# Follow-up authorization for the INASearch OCR setup

The user has now explicitly authorized the INASearch OCR work to take exclusive use of the RTX 5090 instead of sharing VRAM with the currently running Qwen/SGLang instance.

Please do the following yourself on the desktop:

1. Identify the exact Qwen/SGLang process, its owner, launcher/service unit, working directory, and the normal command needed to restore it later. Do not print secrets or unrelated process environment.
2. Stop that Qwen/SGLang workload cleanly through its service/process manager if possible. Do not kill unrelated GPU or desktop processes, change drivers, reboot, or disable the service permanently.
3. Confirm with `nvidia-smi` that the expected VRAM has been released and record the before/after process and memory summary.
4. Then allow the already-running INASearch OCR bootstrap work to load and smoke-test PaddleOCR-VL 1.6, OvisOCR2, and PP-OCRv6 as specified in the original brief.
5. Record the exact safe restore command for Qwen/SGLang in the final setup report, but do not restart it while the INASearch OCR benchmark/batch is using the GPU.

There is another Hermes turn already building `/home/dave/inasearch-ocr-worker`. Avoid editing that worker tree in this follow-up turn; this task is only to free the GPU safely and report the result so the bootstrap turn can proceed.
