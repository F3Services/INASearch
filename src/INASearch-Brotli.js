/* Offline, bounded decoder. The build injects the pinned Rust/WASM factory. */
(() => {
  "use strict";
  const createDecoder = /* INA_SEARCH_DECODER_FACTORY */;
  const binary = /* INA_SEARCH_DECODER_BINARY */;
  let worker = null, fallback = null, nextId = 0;
  const pending = new Map();
  function stopWorker(error) {
    worker?.terminate();
    worker = null;
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); }
    pending.clear();
  }
  function getWorker() {
    if (worker) return worker;
    if (typeof Worker !== "function" || !globalThis.URL?.createObjectURL) return null;
    const source = `const decode = (${createDecoder.toString()})(${JSON.stringify(binary)});
      onmessage = ({ data: { id, bytes, limit } }) => {
        try { const output = decode(bytes, limit); postMessage({ id, output }, [output.buffer]); }
        catch (error) { postMessage({ id, error: String(error?.message || error) }); }
      };`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try { worker = new Worker(url); }
    catch { return null; }
    finally { URL.revokeObjectURL(url); }
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      clearTimeout(job.timer);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.output);
      // The decoded corpus is used outside this worker. Release its WASM heap.
      if (!pending.size) { worker.terminate(); worker = null; }
    };
    worker.onerror = event => { event.preventDefault?.(); stopWorker(new Error("The Brotli decoding worker failed.")); };
    worker.onmessageerror = () => stopWorker(new Error("The Brotli decoding worker returned unreadable data."));
    return worker;
  }
  globalThis.INASearchBrotli = Object.freeze({ async decode(bytes, limit) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 64 * 1024 * 1024) throw new Error("Invalid Brotli output size limit.");
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 64 * 1024 * 1024) throw new Error("Invalid Brotli input byte count.");
    const background = getWorker();
    if (!background) {
      // Offline browsers without Workers retain the same size and format checks.
      fallback ||= createDecoder(binary);
      return fallback(bytes, limit);
    }
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => stopWorker(new Error("Brotli decoding exceeded its time limit.")), 30000);
      pending.set(id, { resolve, reject, timer });
      try { background.postMessage({ id, bytes, limit }); }
      catch (error) { stopWorker(error); }
    });
  } });
})();
