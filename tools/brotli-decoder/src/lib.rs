#![forbid(unsafe_code)]

use brotli_decompressor::{BrotliDecompressStream, BrotliResult, BrotliState, StandardAlloc};
use wasm_bindgen::prelude::*;

// Allocate exactly the verified manifest's output size, never an expanding Vec.
// The streaming decoder cannot write past this slice. Its safe Rust feature set
// retains bounds checks, and the WASM build additionally caps linear memory.
#[wasm_bindgen]
pub fn decompress(input: &[u8], expected_bytes: usize) -> Result<Vec<u8>, JsError> {
    if expected_bytes == 0 || expected_bytes > 64 * 1024 * 1024 {
        return Err(JsError::new("Invalid Brotli output size limit."));
    }
    let mut output = vec![0; expected_bytes];
    let mut state = BrotliState::new(StandardAlloc::default(), StandardAlloc::default(), StandardAlloc::default());
    let mut available_in = input.len();
    let mut input_offset = 0;
    let mut available_out = output.len();
    let mut output_offset = 0;
    let mut total_out = 0;
    let result = BrotliDecompressStream(
        &mut available_in, &mut input_offset, input,
        &mut available_out, &mut output_offset, &mut output,
        &mut total_out, &mut state,
    );
    match result {
        BrotliResult::ResultSuccess => {
            if available_in != 0 || input_offset != input.len() {
                return Err(JsError::new("Trailing data after the Brotli stream."));
            }
            if output_offset != expected_bytes {
                return Err(JsError::new("Unexpected Brotli output byte count."));
            }
            Ok(output)
        }
        BrotliResult::NeedsMoreOutput => Err(JsError::new("Brotli output exceeds its size limit.")),
        _ => Err(JsError::new("Invalid or truncated Brotli stream.")),
    }
}
