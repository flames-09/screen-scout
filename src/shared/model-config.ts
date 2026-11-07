/**
 * Model configuration for NVIDIA NIM.
 *
 * IMPORTANT: a model is only *suggested* here, never asserted to support
 * vision. The "Test connection" action in Settings verifies that the current
 * endpoint accepts an image payload for the chosen model — that is the only
 * thing that marks a model as verified for the user.
 */

export interface ModelSuggestion {
  id: string
  label: string
  note: string
}

/**
 * Vision-capable candidates from the NVIDIA API Catalog. Verified schemas
 * (image_url content parts + SSE streaming) as of the NIM docs; model
 * availability can change — Test connection gives the real answer.
 */
export const SUGGESTED_VISION_MODELS: ModelSuggestion[] = [
  {
    id: 'meta/llama-3.2-90b-vision-instruct',
    label: 'Llama 3.2 90B Vision',
    note: 'Strong general vision model — recommended default.'
  },
  {
    id: 'nvidia/nemotron-nano-12b-v2-vl',
    label: 'Nemotron Nano 12B v2 VL',
    note: 'Smaller and faster; good for quick questions.'
  },
  {
    id: 'microsoft/phi-3.5-vision-instruct',
    label: 'Phi 3.5 Vision',
    note: 'Lightweight vision model.'
  }
]

export const CUSTOM_MODEL_ID = '__custom__'
