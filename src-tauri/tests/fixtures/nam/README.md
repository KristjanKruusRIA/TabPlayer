# NAM test fixtures

Two small models from NAM Core. They test the `.nam` parser and drive the engine parity tests against nam-rs, the `nam-bench` timings and the desktop proof (`tests/desktop/parity-nam-capture.mjs`, which imports `wavenet.nam`). The trainer exports below are used by the parser, parity and budget tests.

- Source: https://github.com/sdatkinson/NeuralAmpModelerCore/tree/0b3d3c97b0859a3a8c92a8628c4dd89a25eb5842/example_models
- Commit: `0b3d3c97b0859a3a8c92a8628c4dd89a25eb5842`
- Files: `wavenet.nam` (WaveNet A1, two layer arrays, 131 weights) and `lstm.nam` (one LSTM layer, 70 weights), both file version 0.5.4.
- Every other test model is built synthetically in code.

NAM Core is distributed under the MIT licence:

```text
MIT License

Copyright (c) 2023 Steven Atkinson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Trainer exports

`wavenet_standard.nam` (13,802 weights) and `wavenet_minimal.nam` (9 weights) are version 0.7.0 files written by the NAM trainer. They use the nested layer `head` and `ReLU`, which the Core examples above do not.

- Source: https://github.com/sdatkinson/neural-amp-modeler/tree/e680deaf4ed1d28ea260e7267680b9f10fed24b8/tests/resources/models/identity
- Commit: `e680deaf4ed1d28ea260e7267680b9f10fed24b8`

The trainer repository is also MIT:

```text
MIT License

Copyright (c) 2019-2025 Steven Atkinson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
