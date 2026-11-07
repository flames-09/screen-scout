# Screen Scout — Desktop App Specification

> **Purpose:** A lightweight desktop AI assistant that stays in the background. Press `Shift+R` to open a compact floating chat, select any region of the screen, ask a question about it, and receive a response from a vision-capable NVIDIA NIM model.
>
> **Product direction:** Windows-first, fast, discreet, privacy-conscious, and visually polished. The interface should feel like a premium translucent utility—not a full-sized chatbot website.

## 1. Product summary

**Working name:** Screen Scout  
**Platform for MVP:** Windows 10/11 (design the architecture so macOS support can be added later)  
**App type:** Background desktop utility with a system-tray icon and a global keyboard shortcut  
**AI provider:** NVIDIA NIM API, using the user's own NVIDIA API key  
**Primary shortcut:** `Shift+R` (editable in Settings)

### The core experience

1. The app launches quietly and remains available in the Windows system tray.
2. The user presses `Shift+R` anywhere in Windows.
3. A small, floating glass-style assistant appears above other windows.
4. The user clicks **Select screen area**. A dimming overlay appears; the user drags a rectangle around the relevant area and releases.
5. The selected crop is previewed in the chat with **Remove** and **Retake** actions.
6. The user types a question (or uses a suggested prompt) and clicks **Send**.
7. The app sends the question and cropped image to the configured vision model through NVIDIA NIM.
8. The model's response appears in the same compact chat. The user can continue asking follow-up questions about the captured image.
9. The user can copy the response, recapture a new region, clear the conversation, or dismiss the popup. Dismissing the popup must not quit the background app.

**Important behavior:** Selecting a screen area alone must not upload it. The upload happens only when the user presses **Send**. If the user closes the popup before sending, discard the unsent crop from memory.

## 2. Goals and non-goals

### Goals

- Make visual assistance available from any desktop app without changing windows or opening a browser.
- Make the capture → ask → answer loop feel immediate and intuitive.
- Support screenshots as image input, not only extracted text.
- Keep the AI API key out of renderer code, source control, logs, and plain-text settings files.
- Make the app unobtrusive while idle and keyboard-accessible while open.
- Deliver a consistent green-and-black glassmorphic visual identity.

### Non-goals for the MVP

- No autonomous clicking, typing, or controlling other applications.
- No continuous screen recording or background screenshot monitoring.
- No automatic upload of screenshots or clipboard contents.
- No account system, cloud-synced chat history, or app-owned AI proxy server.
- No OCR-only processing pipeline. The selected vision model receives the image directly.
- No attempt to bypass application capture restrictions, DRM, or operating-system security prompts.

## 3. Target user and primary use cases

The app should be useful when a user wants to:

- Explain an error dialog, code snippet, chart, settings panel, or unfamiliar UI.
- Understand a screenshot, diagram, graph, or on-screen instructions.
- Ask for help with a visible programming error without manually uploading a screenshot to a website.
- Extract or summarize information from a visible table or document excerpt.
- Ask follow-up questions while the same captured image remains in the conversation context.

## 4. Functional requirements

### 4.1 Background lifecycle and tray

- The app should start into the background rather than opening a full window.
- Add a tray icon with the actions **Open assistant**, **Settings**, and **Quit**.
- Closing the popup hides it; it must not end the process.
- Quit must fully unregister the global shortcut and dispose of windows/resources.
- Support an optional **Launch on startup** setting, disabled or enabled according to the final installer decision. Make its state visible in Settings.
- If `Shift+R` cannot be registered because another application owns it, show a clear Settings/tray error and allow the user to choose another shortcut. Never silently claim the shortcut is active when it is not.
- The shortcut must be configurable in Settings. Validate that it is not empty and handle conflicts gracefully.

### 4.2 Floating assistant window

- Show a compact, always-on-top popup near the center of the active display or near the pointer where practical.
- Suggested initial size: approximately **440 × 560 px**, with reasonable minimum and maximum sizes and a resize affordance if it does not compromise the compact design.
- Use a frameless custom window with rounded corners and a subtle shadow.
- The window must not steal focus until it is intentionally opened by the shortcut or tray action.
- The popup should support drag-to-move using a clearly defined header region.
- `Esc` should cancel an active selection first; if no selection is active, it should dismiss the popup.
- Clicking outside the popup should not accidentally discard an in-progress response. Use a predictable hide policy and preserve an unsent prompt only while the popup remains open.
- Provide visible states for idle, selecting, image attached, sending, streaming response, completed, and error.

### 4.3 Screen-region capture

- The **Select screen area** button starts selection mode across the relevant display(s).
- Display a transparent/dim overlay over the target screen with a crosshair cursor and a high-contrast green selection border.
- Let the user drag to create a rectangular selection. Show live width/height or a subtle dimension indicator while dragging.
- Allow the user to cancel selection with `Esc` or right-click.
- Support negative virtual-screen coordinates and mixed-DPI displays; map overlay coordinates to screenshot pixels correctly.
- Capture only the selected rectangle, not the full desktop, when technically possible.
- Crop the captured screen image in memory and preview the result before sending.
- Offer **Retake** and **Remove** controls. Retake returns to selection mode; Remove removes the attachment without closing the chat.
- Normalize the crop to a format accepted by the chosen model (PNG or JPEG). Respect configurable size limits and resize large crops proportionally without making text needlessly illegible.
- If capture fails or the selected area is invalid/too small, show a helpful message and allow retry.
- If the user selects an area containing sensitive information, the app must not attempt to infer or redact it automatically in the MVP; the preview step gives the user an opportunity to remove the attachment before upload.

### 4.4 Chat and prompts

- The chat view includes a scrollable message history, image attachment preview, multi-line composer, **Select screen area**, **Send**, and **Copy response** controls.
- When no image is attached, sending a text-only prompt may be supported, but the core workflow must prominently encourage selecting an area first.
- If an image is attached and the user sends an empty prompt, either disable Send or use the explicit fallback prompt: **“Describe this screen area and point out anything important.”** Do not silently send an ambiguous blank message.
- Include optional quick prompts after capture, such as:
  - “Explain what I'm looking at.”
  - “Find the error and suggest a fix.”
  - “Summarize the important details.”
  - “Read the visible text.”
- The user can ask follow-up questions against the same image. Keep the active image available to the current conversation until the user removes it, captures a new one, clears the conversation, or closes the popup.
- Use a clear loading state and disable duplicate sends while the same request is pending.
- Support streaming responses when compatible with the chosen model endpoint; otherwise render the completed response without freezing the UI.
- Render basic Markdown safely (paragraphs, lists, inline code, fenced code blocks, links). Do not allow model output to run scripts or arbitrary HTML.
- Add **Copy** to assistant responses. A copied response should preserve readable formatting where possible.
- Add **New chat / Clear** with a confirmation if it will discard unsent work. Do not persist conversations by default in the MVP.

### 4.5 NVIDIA NIM integration

- Use the cloud API endpoint `https://integrate.api.nvidia.com/v1/chat/completions` as the default for NVIDIA-hosted API Catalog models. Keep the base URL configurable internally so a later version can support a self-hosted NIM endpoint.
- Authenticate using the user's NVIDIA API key in the `Authorization: Bearer <key>` header.
- Make the model ID configurable in Settings or in an internal typed configuration. Do **not** assume every NIM model accepts images.
- The selected model must explicitly support vision/image input and the chosen endpoint's image payload format. Validate this in the model selection guidance and include a **Test connection** action.
- Send the cropped image as a supported image content part (for example, an `image_url` whose URL is a `data:image/png;base64,...` data URI), alongside the user's text prompt. Follow the exact schema of the selected model's current endpoint documentation.
- Send only the cropped image, the prompt, the minimum conversation context needed, and the model options required for inference. Do not send the full desktop or unrelated local files.
- Keep API request code in the Electron main process or a trusted service layer—not in the renderer. The renderer must never receive the raw API key.
- Handle at least these conditions with useful, non-technical user-facing messages: missing key, invalid key/401, insufficient credits/402, rate limit/429, unsupported image or invalid request/400/422, network timeout/offline, empty response, and server error.
- Use a configurable request timeout. Allow cancellation where feasible and prevent a late response from overwriting a newer chat state.
- Avoid automatic retries for authorization failures or insufficient-credit errors. For transient network/5xx errors, permit at most one conservative retry if the request has not been cancelled.
- Stream tokens when supported by the selected API schema; properly consume Server-Sent Events, including the terminal `[DONE]` event. Ensure the main process can forward incremental text safely to the renderer.
- Put the model ID and inference parameters in one provider adapter so different NIM model schemas can be handled without scattering model-specific conditionals throughout the UI.
- Default generation settings should favor useful, concise explanations. Make advanced sampling settings out of scope for the MVP unless straightforward to expose.

#### Request shape (illustrative; verify against the selected model)

```json
{
  "model": "<configured-vision-capable-model-id>",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful desktop visual assistant. Answer the user's question about the provided screenshot. Be clear, concise, and honest about uncertainty. Do not claim to have interacted with the user's computer."
    },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "<user question>" },
        {
          "type": "image_url",
          "image_url": { "url": "data:image/png;base64,<base64-crop>" }
        }
      ]
    }
  ],
  "stream": true
}
```

This payload is an implementation example, not a guarantee that every NIM model uses an identical schema. The adapter must match the configured model's current documentation.

### 4.6 Settings

Create a small settings window or settings panel with:

- NVIDIA API key field with show/hide toggle; mask the value by default.
- **Save key securely** and **Remove key** actions.
- **Test connection** that makes a minimal request using the configured model and displays a clear success/failure result.
- Model ID field or a curated list of verified vision-capable models. A model should not be labeled “vision supported” unless the implementation has verified the selected endpoint accepts image input.
- Global shortcut configuration, defaulting to `Shift+R`.
- Optional launch-on-startup switch.
- Optional “Keep chat history for this session” toggle only if ephemeral history is implemented cleanly; do not enable disk history by default.
- Short privacy note explaining that the selected screenshot crop and prompt are sent to NVIDIA when the user presses Send.

### 4.7 Key storage and privacy

- Use Electron's OS-backed secure storage (`safeStorage` asynchronous APIs where available) for the NVIDIA key. On Windows, this uses OS protection such as DPAPI when available.
- Never store the key in source code, `.env` shipped with the app, renderer local storage, logs, analytics, crash reports, or plaintext config.
- If OS-backed encryption is unavailable, do not silently fall back to plaintext. Explain the issue and ask the user to resolve it or keep the key only for the current session.
- Never include the key in error messages. Redact authorization headers and request payloads from logs.
- Treat screenshots, prompts, and model responses as potentially sensitive. Do not add telemetry or upload content for diagnostics in the MVP.
- Do not save screenshot images to disk unless the user explicitly uses a future export feature. Prefer in-memory capture and cleanup after the session.
- Clear image buffers and temporary references as soon as they are no longer needed. Explain that memory clearing is best-effort in a managed runtime.
- Provide an explicit reminder before the first request that the image and prompt will be sent to the configured NVIDIA service.
- No background capture and no silent network calls triggered by the hotkey alone.

## 5. Visual and interaction design

### 5.1 Art direction

**Theme:** dark glassmorphism with neon/emerald green accents. The UI should look modern, clean, focused, and premium without being flashy or cluttered.

- Background: deep near-black (`#070A08` to `#0B100D`) with subtle green ambient gradients.
- Glass panels: translucent charcoal-green surfaces with blur, very subtle inner highlights, and low-contrast borders.
- Primary accent: saturated emerald green (approximately `#22E887`); use a softer green for hover states and a darker green for pressed states.
- Main text: off-white (`#EAF2ED`); secondary text: muted sage gray (`#91A198`).
- Use green for important actions, selected regions, focus rings, and small status indicators—not for every icon or text label.
- Borders should be understated. Avoid excessive glow, thick outlines, loud gradients, or overly rounded “toy-like” controls.
- Use a clean modern font such as **Inter** (preferred) or a bundled, properly licensed equivalent. Use consistent weights and excellent legibility at small sizes.
- Use Lucide-style icons or a similarly coherent line-icon set. Keep icon stroke width and sizing consistent.
- Motion should be short and purposeful: 120–200 ms opacity/scale transitions, with support for reduced-motion settings.

### 5.2 Assistant popup layout

1. **Header:** small brand glyph/name, status or selected model label, Settings icon, close/hide control.
2. **Conversation region:** compact message bubbles with strong spacing and a subtle assistant accent. Keep the latest message visible when streaming, but do not force-scroll if the user has scrolled upward to read older content.
3. **Attachment strip:** selected screenshot thumbnail, filename-free label such as “Screen capture,” and Retake/Remove actions.
4. **Composer:** multi-line text entry with a quiet placeholder (“Ask about this screen…”), Select screen area control, and green Send button.
5. **Footer/status:** lightweight connection status or sending indicator only when useful. Avoid a permanently large status bar.

### 5.3 Screen selection overlay

- Dim the underlying display with a neutral dark layer.
- Use a clear emerald selection outline and very subtle green edge glow.
- The selected region should remain crisp and undimmed where the platform permits.
- Show concise instructions near the cursor: “Drag to select · Esc to cancel.”
- Ensure the overlay never captures the screenshot as part of the crop. Capture the underlying desktop before overlay composition or use the appropriate native capture path.
- Selection should work with mouse and basic keyboard cancellation. Avoid animated effects that interfere with precise selection.

### 5.4 Accessibility and usability

- Provide visible keyboard focus and sufficient contrast.
- All primary buttons must have accessible names and tooltips where icon-only.
- Use logical tab order and keyboard navigation.
- Respect Windows text scaling and reduced-motion preferences where practical.
- Do not rely on color alone to communicate loading, success, or error.
- Keep the popup usable at 100%, 125%, 150%, and 200% display scaling.

## 6. Recommended technical architecture

### Preferred MVP stack

- **Electron** for the background process, tray, global shortcut, desktop window management, and native screen-capture integration.
- **TypeScript** for all application code.
- **React + Vite** for the UI.
- **CSS Modules or a small token-based CSS system** for the design. Use CSS backdrop filters for the glass appearance, with a readable opaque fallback when blur/transparency is unavailable.
- **Zod** or equivalent runtime validation for IPC messages and settings.
- **Lucide React** or an equivalent consistent icon set.
- A maintained Markdown renderer with raw HTML disabled or sanitized.
- Unit tests for provider logic and state transitions; integration/manual tests for global shortcuts and screen capture.

### Process boundaries

**Electron main process**
- Own app lifecycle and single-instance behavior.
- Register/unregister global shortcut.
- Create tray icon, assistant window, settings window, and selection overlay windows.
- Initiate screen capture and crop processing.
- Read/write the encrypted API key through `safeStorage`.
- Make the NVIDIA NIM HTTP request and parse streaming responses.
- Validate and authorize IPC requests from the renderer.

**Preload layer**
- Expose a small, typed, allow-listed API such as `openSelector`, `captureSelectedRegion`, `sendMessage`, `cancelRequest`, `getSettings`, `saveSettings`, `testConnection`, and response-stream subscription.
- Use `contextBridge` and `ipcRenderer` safely.
- Do not expose unrestricted Node APIs, arbitrary IPC channels, filesystem access, or process objects to the renderer.

**Renderer (React UI)**
- Render assistant chat, settings, screenshot preview, and selection UI.
- Manage view state and accessibility.
- Request privileged work only through typed preload methods.
- Never handle the raw API key or independently call the NIM API.

### Electron security baseline

- `contextIsolation: true`.
- `nodeIntegration: false`.
- Use a restrictive Content Security Policy.
- Validate all IPC payloads and message sizes in the main process.
- Do not load arbitrary remote content in privileged windows.
- Avoid `shell.openExternal` on unvalidated URLs from model output; if links are supported, validate and ask before opening external destinations.
- Keep Electron and dependencies updated.

## 7. Suggested project structure

```text
screen-scout/
├─ package.json
├─ electron-builder.yml
├─ tsconfig.json
├─ vite.config.ts
├─ src/
│  ├─ main/
│  │  ├─ index.ts                 # app lifecycle and single-instance guard
│  │  ├─ tray.ts                  # tray menu and icon
│  │  ├─ windows.ts               # assistant/settings/selection windows
│  │  ├─ shortcuts.ts             # global hotkey registration
│  │  ├─ capture/
│  │  │  ├─ capture-service.ts    # capture selected monitor/region
│  │  │  └─ image-processing.ts   # crop, resize, encode, size validation
│  │  ├─ ai/
│  │  │  ├─ nim-client.ts         # HTTP client and error mapping
│  │  │  ├─ model-config.ts       # model ID and capabilities
│  │  │  └─ stream-parser.ts      # SSE parsing/cancellation
│  │  ├─ security/
│  │  │  ├─ secrets.ts            # encrypted API-key storage
│  │  │  └─ ipc-validation.ts     # schemas and channel authorization
│  │  └─ settings/
│  │     └─ settings-store.ts     # non-secret preferences only
│  ├─ preload/
│  │  └─ index.ts                 # minimal typed bridge
│  ├─ renderer/
│  │  ├─ App.tsx
│  │  ├─ components/
│  │  │  ├─ AssistantHeader.tsx
│  │  │  ├─ ChatMessage.tsx
│  │  │  ├─ Composer.tsx
│  │  │  ├─ ScreenshotAttachment.tsx
│  │  │  ├─ SelectionOverlay.tsx
│  │  │  └─ SettingsPanel.tsx
│  │  ├─ hooks/
│  │  ├─ styles/
│  │  │  ├─ tokens.css
│  │  │  └─ app.css
│  │  └─ main.tsx
│  └─ shared/
│     ├─ types.ts
│     └─ schemas.ts
├─ tests/
│  ├─ nim-client.test.ts
│  ├─ settings.test.ts
│  └─ chat-state.test.ts
└─ README.md
```

This is a recommended structure, not a requirement to create empty files before building the working app. Keep components small, but prioritize a functioning end-to-end vertical slice over abstraction for its own sake.

## 8. Main state and interaction model

Use a predictable state machine rather than unrelated boolean flags. Suggested states:

- `hidden`
- `ready` — popup open, no active selection or request
- `selecting`
- `image-attached`
- `sending`
- `streaming`
- `complete`
- `error`

Expected transitions:

- `hidden` → `ready`: hotkey or tray command.
- `ready` → `selecting`: Select screen area.
- `selecting` → `image-attached`: valid rectangle selected.
- `selecting` → `ready`: selection cancelled or invalid.
- `image-attached` → `sending`: Send clicked with a valid prompt or fallback prompt.
- `sending` → `streaming`: first model token arrives (when streaming is supported).
- `sending`/`streaming` → `complete`: final valid response received.
- `sending`/`streaming` → `error`: request fails or is cancelled.
- `error` → `image-attached` or `ready`: retry, remove crop, or edit prompt.
- Any open state → `hidden`: dismissed; cancel in-flight request if product behavior says dismissal should cancel it.

Do not allow duplicate Send clicks to create duplicate network requests. Give each request an ID so late chunks from a cancelled or superseded request are ignored.

## 9. Image and network constraints

- Enforce a sensible maximum image payload before sending; start with a configurable cap around **5 MB of encoded image data** and adjust after testing supported models.
- Resize only when necessary. Prefer preserving sharp text over aggressive compression.
- Validate that the selected crop has nonzero dimensions and that the encoded image type matches the data URI.
- Do not include desktop monitor metadata beyond what is needed to crop the screenshot.
- Avoid writing base64 payloads to logs or persistent state.
- Provide an actionable error if the selected image exceeds limits: ask the user to select a smaller area or reduce image size.
- Use request cancellation with `AbortController` or equivalent where supported. Treat a user cancellation as an expected state, not as a crash.

## 10. Error handling and user-facing copy

Use brief, plain-language copy. Examples:

- **No API key:** “Add your NVIDIA API key in Settings to start asking questions.”
- **Invalid key:** “NVIDIA rejected this API key. Check the key in Settings.”
- **Model cannot process images:** “This model does not support screenshots. Choose a vision-capable model in Settings.”
- **Rate limit:** “NVIDIA is receiving too many requests. Try again shortly.”
- **Credits/quota:** “The NVIDIA API account reports that no usable credits or quota are available.”
- **Offline/timeout:** “Couldn’t reach NVIDIA. Check your connection and try again.”
- **Empty response:** “The model returned an empty response. Try again or choose another model.”
- **Capture failed:** “Couldn’t capture that area. Try selecting it again.”

Keep technical status codes in an expandable details section or developer log, never as the only explanation.

## 11. Performance and quality requirements

- The app should remain idle with low CPU usage and no continuous screen capture.
- Opening the popup should feel immediate; target under **250 ms** on a typical modern Windows PC, excluding OS scheduling.
- Starting selection should respond immediately and avoid flicker.
- The UI must remain responsive while the main process performs image processing or network requests.
- Show visible progress for requests lasting longer than a brief moment.
- Recover cleanly from API timeouts, sleep/wake, temporary network loss, and shortcut-registration failure.
- Do not lose the current prompt because of a failed request.
- Use a single app instance and ensure a second launch focuses the existing instance instead of registering a duplicate shortcut.

Latency goals are aspirations, not guarantees; model response time depends on the selected NIM model and network conditions.

## 12. Testing and acceptance criteria

The MVP is accepted when all of the following are demonstrably true:

### Background and shortcut
- [ ] Launching the app does not open a large foreground window.
- [ ] The tray icon and menu work.
- [ ] `Shift+R` opens the assistant from another app, including while the app is hidden.
- [ ] The hotkey can be changed, conflicts are reported clearly, and quitting unregisters it.
- [ ] Hiding the assistant does not quit the process.

### Screen capture
- [ ] Selection overlay appears on the expected display and the user can drag a rectangle.
- [ ] `Esc` cancels selection.
- [ ] The captured image matches the selected rectangle; the overlay itself is not in the capture.
- [ ] Preview, Retake, and Remove work.
- [ ] At least one mixed-DPI / multi-monitor scenario is tested on Windows.
- [ ] Selecting a region does not upload it. Only Send initiates a request.

### NVIDIA NIM
- [ ] A saved NVIDIA API key is encrypted through OS-backed secure storage; it is not accessible from renderer code.
- [ ] A verified vision-capable model successfully receives an image and prompt and returns a useful answer.
- [ ] Follow-up questions retain the correct image context for that chat.
- [ ] Loading, streaming (if supported), completion, cancellation, and failure states work.
- [ ] Invalid keys, rate limiting, insufficient credits/quota, network failure, and unsupported image input show understandable errors.
- [ ] Logs contain no API key, screenshot contents, or base64 image payload.

### UI and safety
- [ ] The popup uses the green/black glass theme, a clean font, subtle transitions, and readable contrast.
- [ ] The app never captures or uploads in the background.
- [ ] Closing before sending discards the pending image.
- [ ] Clear chat removes the active image and messages from app state.
- [ ] Model output is rendered as safe text/Markdown, not executable HTML.
- [ ] Keyboard focus, input, Send, Copy, and close behavior are usable without a mouse where practical.

## 13. Build order for an AI coding agent

Implement in this order. Keep each stage runnable before adding the next:

1. **App shell:** Electron + TypeScript + React/Vite, secure defaults, single-instance behavior, system tray, and a basic dark-green popup.
2. **Global shortcut:** register `Shift+R`, open/focus the popup, support dismissing without quitting, and add hotkey conflict handling.
3. **Selection overlay:** select a rectangle, map coordinates correctly, capture/crop the underlying display, and show the image preview. Test multi-monitor/DPI behavior before proceeding.
4. **Secure settings:** add NVIDIA API key entry, secure `safeStorage` persistence, model ID setting, and Test connection. Keep secrets out of the renderer and plaintext config.
5. **NIM vision request:** implement one verified vision-capable model, user prompt plus image payload, clear error handling, and cancellation.
6. **Chat loop:** message history, follow-up questions, streaming if supported, Copy, Retake, Remove, and New chat.
7. **Visual polish:** refine translucent surfaces, spacing, typography, hover/focus/loading states, motion, and accessibility.
8. **Packaging and QA:** create a Windows installer, verify startup behavior and shortcut lifecycle, test error states and key protection, and document first-run setup.

**Build discipline:** Do not mock the model forever or stop at a static UI. Complete one real end-to-end path—hotkey → select region → preview → send to NVIDIA NIM → display answer—before spending significant time on animation or optional features.

## 14. Definition of done

A new user should be able to install the app, open Settings, save their NVIDIA API key, choose a vision-capable NIM model, press `Shift+R` from any normal desktop application, select a region, ask a question, receive a response, copy the answer, and dismiss the popup while the app remains available in the system tray. The entire flow should feel fast, safe, and visually cohesive.

## 15. Official implementation references

Use the latest documentation during implementation; model availability and request schemas can change.

- NVIDIA NIM API Catalog quickstart: <https://docs.api.nvidia.com/nim/docs/api-quickstart>
- NVIDIA NIM LLM API overview: <https://docs.api.nvidia.com/nim/reference/llm-apis>
- Example NVIDIA vision model reference (Llama 3.2 Vision): <https://docs.api.nvidia.com/nim/reference/meta-llama-3_2-90b-vision-instruct-infer>
- Example NVIDIA vision-language model reference (Nemotron Nano VL): <https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-nano-12b-v2-vl-infer>
- Electron `safeStorage`: <https://www.electronjs.org/docs/latest/api/safe-storage>
- Electron `BrowserWindow`: <https://www.electronjs.org/docs/latest/api/browser-window>
- Electron `globalShortcut`: <https://www.electronjs.org/docs/latest/api/global-shortcut>
- Electron security recommendations: <https://www.electronjs.org/docs/latest/tutorial/security>

---

## Notes for the implementer

- Treat every model ID in examples as configurable. Before declaring a model supported, verify it is currently available to the user's NVIDIA account and accepts image content at the endpoint being called.
- NVIDIA-hosted API Catalog services and self-hosted NIM deployments can differ in authentication, URLs, and supported request fields. This spec targets the hosted API key flow unless the user explicitly configures another endpoint.
- Prioritize a polished, reliable Windows MVP. Keep platform-specific capture code behind an interface so another capture implementation can be added for macOS later.
