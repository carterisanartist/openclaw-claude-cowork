/**
 * The preload script runs in an isolated context with access to both Node and
 * the renderer's window. It safely exposes window.api -> ipcRenderer.invoke.
 *
 * Keep this file thin: validation happens in main, presentation happens in
 * the renderer, this layer is purely a typed bridge.
 */

import { contextBridge, ipcRenderer } from "electron";

import {
  type ClaudeCodeInstallInput,
  type ClaudeCodeInstallResult,
  type ConfigureOpenclawInput,
  type ConfigureOpenclawResult,
  type DetectResult,
  type DiscoverChatInput,
  type DiscoverChatResult,
  type ExistingBridgeStatus,
  IPC_CHANNELS,
  type InitOpenclawInput,
  type InitOpenclawResult,
  type InstallBridgeInput,
  type InstallBridgeResult,
  type InstallDaemonInput,
  type InstallDaemonResult,
  type IpcApi,
  type OpenClawDoctorResult,
  type PairingApproveInput,
  type PairingApproveResult,
  type PairingListResult,
  type RestartGatewayResult,
  type SmokeTestInput,
  type SmokeTestResult,
  type TelemetryConfigInput,
  type TelemetryConfigResult,
  type TestProviderInput,
  type TestProviderResult,
  type UpdateBridgeInput,
  type UpdateBridgeResult,
  type VerifyTokenInput,
  type VerifyTokenResult,
} from "../shared/ipc";

const api: IpcApi = {
  detect: (): Promise<DetectResult> => ipcRenderer.invoke(IPC_CHANNELS.detect),
  verifyToken: (input: VerifyTokenInput): Promise<VerifyTokenResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.verifyToken, input),
  discoverChat: (input: DiscoverChatInput): Promise<DiscoverChatResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.discoverChat, input),
  runOpenclawDoctor: (): Promise<OpenClawDoctorResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.runOpenclawDoctor),
  runOpenclawDoctorFix: (): Promise<OpenClawDoctorResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.runOpenclawDoctorFix),
  runOpenclawStatusDeep: (): Promise<OpenClawDoctorResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.runOpenclawStatusDeep),
  configureOpenclaw: (input: ConfigureOpenclawInput): Promise<ConfigureOpenclawResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.configureOpenclaw, input),
  restartGateway: (): Promise<RestartGatewayResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.restartGateway),
  installDaemon: (input: InstallDaemonInput): Promise<InstallDaemonResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.installDaemon, input),
  pairingList: (): Promise<PairingListResult> => ipcRenderer.invoke(IPC_CHANNELS.pairingList),
  pairingApprove: (input: PairingApproveInput): Promise<PairingApproveResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.pairingApprove, input),
  initOpenclaw: (input: InitOpenclawInput): Promise<InitOpenclawResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.initOpenclaw, input),
  testProvider: (input: TestProviderInput): Promise<TestProviderResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.testProvider, input),
  installBridge: (input: InstallBridgeInput): Promise<InstallBridgeResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.installBridge, input),
  detectExistingBridge: (): Promise<ExistingBridgeStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.detectExistingBridge),
  updateBridge: (input: UpdateBridgeInput): Promise<UpdateBridgeResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.updateBridge, input),
  claudeCodeInstall: (input: ClaudeCodeInstallInput): Promise<ClaudeCodeInstallResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.claudeCodeInstall, input),
  setTelemetry: (input: TelemetryConfigInput): Promise<TelemetryConfigResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.setTelemetry, input),
  getTelemetry: (): Promise<TelemetryConfigResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.getTelemetry),
  smokeTest: (input: SmokeTestInput): Promise<SmokeTestResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.smokeTest, input),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  revealInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.revealInFolder, path),
  quit: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.quit),
};

contextBridge.exposeInMainWorld("api", api);
