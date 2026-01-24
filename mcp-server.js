const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const ROOT_DIR = __dirname;
const SUPPORTED_SYNTHS = {
  bfxr: { name: "Bfxr", className: "Bfxr" },
  footsteppr: { name: "Footsteppr", className: "Footsteppr" },
};

const runtime = {
  console: {
    log: (...args) => console.error(...args),
    info: (...args) => console.error(...args),
    warn: (...args) => console.error(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.error(...args),
  },
  Math,
  Uint8Array,
  Float32Array,
  Array,
  Object,
  Number,
  String,
  Boolean,
  Date,
  setTimeout,
  clearTimeout,
};
vm.createContext(runtime);

let runtimeLoaded = false;
const loadedScripts = new Set();

function loadScript(relativePath) {
  if (loadedScripts.has(relativePath)) return;
  loadedScripts.add(relativePath);
  const filePath = path.join(ROOT_DIR, relativePath);
  const code = fs.readFileSync(filePath, "utf8");
  vm.runInContext(code, runtime, { filename: filePath });
}

function ensureRuntimeLoaded() {
  if (runtimeLoaded) return;
  runtime.SAMPLE_RATE = 44100;
  runtime.CONVERSION_FACTOR = (2 * Math.PI) / runtime.SAMPLE_RATE;

  loadScript("js/globals.js");
  loadScript("js/synths/templates.js");
  loadScript("js/audio/AKWF.js");
  loadScript("js/audio/Bfxr_DSP.js");
  loadScript("js/audio/puredata_modules.js");
  loadScript("js/audio/puredata.js");
  loadScript("js/audio/puredata_parser.js");
  loadScript("js/synths/SynthBase.js");
  loadScript("js/synths/Bfxr.js");
  loadScript("js/synths/Footsteppr.js");
  loadScript("js/audio/riffwave.js");

  // Expose script globals (class/const bindings) on the runtime object.
  vm.runInContext(
    [
      "this.TEMPLATES_JSON = typeof TEMPLATES_JSON !== 'undefined' ? TEMPLATES_JSON : this.TEMPLATES_JSON;",
      "this.SynthBase = typeof SynthBase !== 'undefined' ? SynthBase : this.SynthBase;",
      "this.Bfxr_DSP = typeof Bfxr_DSP !== 'undefined' ? Bfxr_DSP : this.Bfxr_DSP;",
      "this.Bfxr = typeof Bfxr !== 'undefined' ? Bfxr : this.Bfxr;",
      "this.Footsteppr = typeof Footsteppr !== 'undefined' ? Footsteppr : this.Footsteppr;",
      "this.MakeRiff = typeof MakeRiff !== 'undefined' ? MakeRiff : this.MakeRiff;",
    ].join("\n"),
    runtime
  );

  if (!runtime.Bfxr || !runtime.Bfxr_DSP || !runtime.MakeRiff) {
    throw new Error("Failed to load Bfxr runtime.");
  }

  runtimeLoaded = true;
}

function withSeed(seed, fn) {
  if (seed === undefined || seed === null) {
    return fn();
  }
  const originalRandom = runtime.Math.random;
  let state = (seed >>> 0) || 1;
  runtime.Math.random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  try {
    return fn();
  } finally {
    runtime.Math.random = originalRandom;
  }
}

function normalizeSynthName(name) {
  if (!name) return "bfxr";
  return name.toLowerCase();
}

function getSynthInstance(synthName) {
  ensureRuntimeLoaded();
  const normalized = normalizeSynthName(synthName);
  const synthInfo = SUPPORTED_SYNTHS[normalized];
  if (!synthInfo) {
    const available = Object.keys(SUPPORTED_SYNTHS).join(", ");
    throw new Error(`Unknown synth: ${synthName}. Available: ${available}`);
  }
  const SynthClass = runtime[synthInfo.className];
  if (!SynthClass) {
    throw new Error(`Synth class not found: ${synthInfo.className}`);
  }
  return new SynthClass();
}

function buildPresetIndex(synth) {
  const builtIn = (synth.templates || []).map((template) => {
    const [name, description, generator] = template;
    return {
      id: generator.replace(/^generate_/, ""),
      name,
      description,
      generator,
      source: "builtin",
    };
  });

  const jsonTemplates = [];
  if (runtime.TEMPLATES_JSON && runtime.TEMPLATES_JSON[synth.name]) {
    for (const key of Object.keys(runtime.TEMPLATES_JSON[synth.name])) {
      jsonTemplates.push({
        id: key,
        name: key,
        description: "",
        generator: `generate_${key}`,
        source: "bcol",
      });
    }
  }

  const presets = [...builtIn, ...jsonTemplates];
  const byId = new Map();
  for (const preset of presets) {
    byId.set(preset.id.toLowerCase(), preset);
  }
  return { presets, byId };
}

function applyPreset(synth, presetId) {
  if (!presetId) return { preset: null };
  const { byId } = buildPresetIndex(synth);
  const preset = byId.get(presetId.toLowerCase());
  if (!preset) {
    const available = Array.from(byId.keys()).sort();
    throw new Error(`Unknown preset: ${presetId}. Available: ${available.join(", ")}`);
  }
  const generator = preset.generator;
  if (typeof synth[generator] !== "function") {
    throw new Error(`Preset generator not found: ${generator}`);
  }
  synth[generator]();
  return preset;
}

function applyParams(synth, params) {
  if (!params) return;
  for (const [key, value] of Object.entries(params)) {
    synth.set_param(key, value, false);
  }
}

function generateFootstepBuffer(footsteppr) {
  const step_heel = footsteppr.params.heel;
  const step_roll = footsteppr.params.roll;
  const step_ball = footsteppr.params.ball;
  const step_speed = footsteppr.params.swiftness;
  const step_vol = footsteppr.params.masterVolume;

  const step_length = 0.1 + 0.7 * (1 - step_speed);
  runtime.pd_set_stream_length_seconds(step_length);

  const heel_envelope = runtime.resize_fn(runtime.step(step_heel), 0, 1, 0, 0.3333);
  const roll_envelope = runtime.resize_fn(runtime.step(step_roll), 0, 1, 0.125, 0.875);
  const ball_envelope = runtime.resize_fn(runtime.step(step_ball), 0, 1, 0.6667, 1);
  const step_envelope_0_1 = runtime.add_fns(heel_envelope, roll_envelope, ball_envelope);
  const step_envelope_resized = runtime.resize_fn(step_envelope_0_1, 0, 1, 0, step_length);

  const envelope_signal = runtime.pd_fn(step_envelope_resized);

  const terrain_names = ["snow", "grass", "dirt", "gravel", "wood"];
  let terrainIndex = footsteppr.params.terrain;
  if (terrainIndex >= terrain_names.length) {
    terrainIndex = 0;
  }
  const terrain_name = terrain_names[terrainIndex];
  if (!runtime.puredata_functions || !runtime.puredata_functions[terrain_name]) {
    throw new Error(`Terrain generator not found: ${terrain_name}`);
  }

  let signal = runtime.puredata_functions[terrain_name](envelope_signal);
  signal = runtime.pd_mul(signal, runtime.pd_c(step_vol));
  signal = runtime.pd_clip(signal, runtime.pd_c(-1.0), runtime.pd_c(1.0));
  signal = runtime.pd_mul(signal, runtime.pd_c(4.0));

  return signal;
}

function generateWav({
  synth,
  preset,
  params,
  seed,
  returnDataUri = true,
  returnBase64 = true,
  outputPath,
}) {
  const synthInstance = getSynthInstance(synth);
  const presetInfo = withSeed(seed, () => applyPreset(synthInstance, preset));
  applyParams(synthInstance, params);

  let floatBuffer;
  let sampleRate = runtime.SAMPLE_RATE;
  let bitDepth = 16;

  if (synthInstance.name === "Bfxr") {
    const dsp = new runtime.Bfxr_DSP(synthInstance.params, synthInstance);
    dsp.generate_sound();
    floatBuffer = dsp.buffer;
    sampleRate = runtime.Bfxr_DSP.sampleRate || sampleRate;
    bitDepth = runtime.Bfxr_DSP.bitDepth || bitDepth;
  } else if (synthInstance.name === "Footsteppr") {
    floatBuffer = generateFootstepBuffer(synthInstance);
  } else {
    throw new Error(`Unsupported synth: ${synthInstance.name}`);
  }

  const pcm = new Array(floatBuffer.length);
  for (let i = 0; i < floatBuffer.length; i++) {
    const clamped = Math.max(-1, Math.min(floatBuffer[i], 1));
    pcm[i] = (Math.floor(32768 * clamped) | 0);
  }

  const wav = runtime.MakeRiff(sampleRate, bitDepth, pcm);
  const base64 = wav.dataURI.replace(/^data:audio\/wav;base64,/, "");
  const dataUri = returnDataUri ? wav.dataURI : null;

  let savedTo = null;
  if (outputPath) {
    const resolved = path.resolve(ROOT_DIR, outputPath);
    const rootResolved = path.resolve(ROOT_DIR) + path.sep;
    if (!resolved.startsWith(rootResolved)) {
      throw new Error("outputPath must be within the workspace directory.");
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, Buffer.from(base64, "base64"));
    savedTo = resolved;
  }

  return {
    synth: synthInstance.name,
    preset: presetInfo ? presetInfo.id : null,
    params: synthInstance.params,
    sampleRate,
    bitDepth,
    numSamples: floatBuffer.length,
    durationSeconds: floatBuffer.length / sampleRate,
    wavBase64: returnBase64 ? base64 : null,
    dataUri,
    outputPath: savedTo,
  };
}

function listParams(synth) {
  const synthInstance = getSynthInstance(synth);
  return synthInstance.param_info.map((param) => synthInstance.get_param_normalized(param));
}

function listPresets(synth) {
  const synthInstance = getSynthInstance(synth);
  const { presets } = buildPresetIndex(synthInstance);
  return presets.map(({ id, name, description, source }) => ({ id, name, description, source }));
}

function listSynths() {
  return Object.keys(SUPPORTED_SYNTHS).map((key) => ({
    id: key,
    name: SUPPORTED_SYNTHS[key].name,
  }));
}

const server = new Server(
  { name: "bfxr-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "bfxr_list_synths",
      description: "List available synth engines supported by this MCP server.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "bfxr_list_presets",
      description: "List available preset generators for a synth.",
      inputSchema: {
        type: "object",
        properties: {
          synth: {
            type: "string",
            description: "Synth id from bfxr_list_synths (default: bfxr).",
          },
        },
      },
    },
    {
      name: "bfxr_list_params",
      description: "List parameter metadata (name, min, max, default) for a synth.",
      inputSchema: {
        type: "object",
        properties: {
          synth: {
            type: "string",
            description: "Synth id from bfxr_list_synths (default: bfxr).",
          },
        },
      },
    },
    {
      name: "bfxr_generate_wav",
      description: "Generate a WAV sound using a preset and/or parameter overrides.",
      inputSchema: {
        type: "object",
        properties: {
          synth: {
            type: "string",
            description: "Synth id from bfxr_list_synths (default: bfxr).",
          },
          preset: {
            type: "string",
            description: "Preset id from bfxr_list_presets",
          },
          params: {
            type: "object",
            description: "Parameter overrides (e.g. frequency_start, sustainTime).",
          },
          seed: {
            type: "integer",
            description: "Optional seed for deterministic preset generation.",
          },
          returnDataUri: {
            type: "boolean",
            description: "Whether to include dataUri in the response (default: true).",
          },
          returnBase64: {
            type: "boolean",
            description: "Whether to include wavBase64 in the response (default: true).",
          },
          outputPath: {
            type: "string",
            description: "Optional workspace-relative path to save the WAV file.",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "bfxr_list_synths":
      case "bfxr.list_synths":
        return {
          content: [{ type: "text", text: JSON.stringify(listSynths(), null, 2) }],
        };
      case "bfxr_list_presets":
      case "bfxr.list_presets":
        return {
          content: [{ type: "text", text: JSON.stringify(listPresets(args?.synth), null, 2) }],
        };
      case "bfxr_list_params":
      case "bfxr.list_params":
        return {
          content: [{ type: "text", text: JSON.stringify(listParams(args?.synth), null, 2) }],
        };
      case "bfxr_generate_wav":
      case "bfxr.generate_wav":
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(generateWav(args || {}), null, 2),
            },
          ],
        };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
      isError: true,
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
