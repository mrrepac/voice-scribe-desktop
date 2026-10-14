# Third-party notices

Voice Scribe uses the following components. This file is an attribution
index; full license texts are retained in `licenses/` and in the Electron runtime.

| Component | Attribution | License / included text |
|---|---|---|
| Voice Scribe 0.4.1 for Obsidian | Copyright (c) 2026 mrrepac | MIT; project `LICENSE` |
| ONNX Runtime (native, via sherpa-onnx) | Copyright (c) Microsoft Corporation. All rights reserved. | MIT; `licenses/onnxruntime-LICENSE.txt` |
| Electron 44.6.0 | Copyright (c) Electron contributors; Copyright (c) 2013–2020 GitHub Inc. | MIT; `licenses/electron-LICENSE.txt` and runtime `LICENSE.electron.txt` |
| Chromium and bundled runtime components | Their respective authors | Runtime `LICENSES.chromium.html` |
| Tabler Icons 3.49.0 | Copyright (c) 2020–2026 Paweł Kuna | MIT; `licenses/tabler-icons-LICENSE.txt` |

The original Voice Scribe transcript cleanup and text-processing code
was reused or adapted for this standalone application.
The original MIT notice is retained in the project's `LICENSE` file. Application
integration and global Windows insertion are implemented separately from Obsidian.

Development tools and their dependencies retain their own notices in
`node_modules`. The locked versions used for this build are recorded in
`package-lock.json`.

Recognition uses sherpa-onnx-node 1.13.8 (Next-gen Kaldi team, Apache-2.0;
licenses/sherpa-onnx-LICENSE.txt), with its native ONNX Runtime (MIT;
licenses/onnxruntime-LICENSE.txt). Source: https://github.com/k2-fsa/sherpa-onnx.

The GigaAM v3 recognizer for Russian (GigaChat Team, Sber; MIT;
licenses/gigaam-LICENSE.txt) also runs on sherpa-onnx-node. Its ONNX conversion
with punctuation, from csukuangfj's Hugging Face repository
sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16, is included in
the installer under resources/models/gigaam-v3-punct. The build fetches it with
scripts/fetch-model.mjs; the revision and SHA-256 digests are pinned in
src/shared/gigaam-model.json. A source checkout downloads the same files on first use. Source: https://github.com/salute-developers/GigaAM.
