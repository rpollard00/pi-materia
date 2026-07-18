export const CENTRAL_ADMIN_SECTIONS = ['catalog', 'policy', 'telemetry', 'server'] as const;
export type CentralAdminSection = (typeof CENTRAL_ADMIN_SECTIONS)[number];

export interface CentralAdminBackendMode {
  ok?: boolean;
  service?: string;
  mode?: string;
  hasLocalSession?: boolean;
  hasCentral?: boolean;
  label?: string;
  capabilities?: {
    catalog?: boolean;
    modelPolicy?: boolean;
    telemetry?: boolean;
    admin?: boolean;
  };
  endpoints?: {
    local?: { available?: boolean; sameOrigin?: boolean; baseUrl?: string };
    central?: { available?: boolean; sameOrigin?: boolean; baseUrl?: string };
  };
}

export interface CentralAdminServerMetadata {
  service: string;
  mode: string;
  buildVersion: string;
  schemaVersion: number;
  authMethods: readonly string[];
  startedAt?: string;
  label?: string;
  capabilities?: Record<string, boolean>;
}

export interface CentralAdminRoleSummary {
  roleId: string;
  name?: string;
  permissions: readonly string[];
}

export interface CentralAdminPrincipalSummary {
  principalId: string;
  subject?: string;
  tenantId: string;
  roleIds: readonly string[];
}

export interface CentralAdminMetadata {
  server: CentralAdminServerMetadata;
  roles: readonly CentralAdminRoleSummary[];
  principals?: readonly CentralAdminPrincipalSummary[];
}

export interface CentralAdminMetadataEnvelope {
  ok?: boolean;
  metadata?: CentralAdminMetadata;
}
