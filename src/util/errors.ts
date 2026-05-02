/**
 * Verona's error hierarchy. Every error thrown by Verona internals is an
 * instance of one of these. Throwing raw strings or generic Error is a lint
 * error.
 *
 * See knowledge/conventions/error-handling.md for the rules.
 */

export type VeronaErrorType =
  | "config"
  | "secret"
  | "adapter"
  | "connector_send"
  | "memory_guard"
  | "schedule"
  | "state";

export class VeronaError extends Error {
  readonly type: VeronaErrorType;

  constructor(type: VeronaErrorType, message: string, options?: ErrorOptions) {
    super(message, options);
    this.type = type;
    this.name = this.constructor.name;
  }
}

export class ConfigError extends VeronaError {
  constructor(message: string, options?: ErrorOptions) {
    super("config", message, options);
  }
}

export class SecretError extends VeronaError {
  constructor(message: string, options?: ErrorOptions) {
    super("secret", message, options);
  }
}

export class AdapterError extends VeronaError {
  readonly adapterId: string;

  constructor(adapterId: string, message: string, options?: ErrorOptions) {
    super("adapter", `[${adapterId}] ${message}`, options);
    this.adapterId = adapterId;
  }
}

export class ConnectorSendError extends VeronaError {
  readonly connectorId: string;

  constructor(connectorId: string, message: string, options?: ErrorOptions) {
    super("connector_send", `[${connectorId}] ${message}`, options);
    this.connectorId = connectorId;
  }
}

export class MemoryGuardError extends VeronaError {
  constructor(message: string, options?: ErrorOptions) {
    super("memory_guard", message, options);
  }
}

export class ScheduleError extends VeronaError {
  constructor(message: string, options?: ErrorOptions) {
    super("schedule", message, options);
  }
}

export class StateError extends VeronaError {
  constructor(message: string, options?: ErrorOptions) {
    super("state", message, options);
  }
}
