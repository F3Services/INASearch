# Final no-GPU postflight only

Do not rerun OCR, load any model, restart any service, or alter any result, queue, accepted input, worker source, commit, or existing evidence file. Qwen must remain stopped, and `/home/dave/.local/bin/start-qwen` must not be executed.

The recovery OCR and authoritative offline verification are already complete at:

`/home/dave/inasearch-ocr-worker/tmp/batch/ocr-recovery-16x3-3e3e032-20260831T041925Z`

Perform only a narrow final-state audit and write a new supplemental file there named `final-runtime-state.json`. Do not overwrite `completion-summary.json`.

The earlier generic Qwen detector was not sufficient because this host's actual Qwen server executable is `/home/dave/src/ninfer/build/apps/ninfer-serve`, with process comm `ninfer-serve`, and its serving port is 8084. Prove all of the following directly, while excluding this Hermes prompt/process from process-name matching:

1. No running process has executable path `/home/dave/src/ninfer/build/apps/ninfer-serve`.
2. No running process has comm exactly `ninfer-serve`.
3. No process is listening on TCP port 8084. Record whether `ss` itself succeeded; a parser or command failure must not be reported as absence.
4. The OCR user service is inactive with MainPID 0.
5. No PP-OCR, PaddleOCR-VL, or Ovis model worker/server remains running, using exact executable/cmdline inspection that cannot match this prompt text.
6. `nvidia-smi` succeeds and reports no compute processes; preserve the raw query/output or a hash-addressed companion file.
7. Git worktree remains clean at exact commit `3e3e03237d401439e992ddbbc76b76bffb68aacc`.

The JSON must include a UTC timestamp, exact commands/check definitions, raw or losslessly structured observations, per-check booleans, an overall `success` that is true only if every check ran successfully and proved the required stopped/clean state, and the Qwen restore command as metadata with `executed:false`. Hash the supplemental JSON and report the absolute path and SHA-256. Leave all services/models stopped.
