import type { Device, DevicePref, DownloadPlan, ModelPref, ProgressInfo, WhisperModel } from "./engine";
import type { Transcript } from "../shared/transcript";

export interface LoadedInfo {
  model: WhisperModel;
  device: Device;
  f16: boolean;
  fellBack: boolean;
}

export type ToWorker =
  | { t: "plan"; id: number; pref: ModelPref; devicePref: DevicePref }
  | { t: "load"; id: number; pref: ModelPref; devicePref: DevicePref }
  | { t: "run"; id: number; pcm: Float32Array; language: string; language2: string; segment: boolean }
  | { t: "run-timed"; id: number; pcm: Float32Array; language: string; language2: string; segment: boolean }
  | { t: "cache-reply"; id: number; error?: string };

export type FromWorker =
  | { t: "ready" }
  | { t: "progress"; id: number; p: ProgressInfo }
  | { t: "plan"; id: number; plan: DownloadPlan }
  | { t: "loaded"; id: number; info: LoadedInfo }
  | { t: "text"; id: number; text: string }
  | { t: "transcript"; id: number; transcript: Transcript }
  | { t: "error"; id: number; message: string }
  | { t: "cache-put"; id: number; key: string; buf: ArrayBuffer };
