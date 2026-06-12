/**
 * Single source of truth for the connector catalog.
 *
 * Adding a connector is ONE entry in `CONNECTORS` below — registration, the
 * config-presence check (`configured`), the UI catalog, and the generic
 * auto-backfill/sync path in platform.ts all derive from this list. There is no
 * per-connector wiring to keep in sync across three places anymore
 * (docs/08-ux-experience-guidelines.md: one place, no duplicate code).
 */
import {
  NotionConnector,
  GoogleDriveConnector,
  GitHubConnector,
  GmailConnector,
  GoogleCalendarConnector,
  SlackSourceConnector
} from "@companyos/connectors";
import type { SourceConnector } from "@companyos/connectors";
import type { CoreConfig } from "./config.js";

export type ConnectorKind = "source" | "outbound" | "webhook";

export interface ConnectorDef {
  name: string;
  label: string;
  category: string;
  kind: ConnectorKind;
  /** True when creds for a real (non-demo) link are present in config. */
  configured: (config: CoreConfig) => boolean;
  /** Build the source-connector instance. Present for `kind: "source"` only. */
  create?: (config: CoreConfig) => SourceConnector;
}

/**
 * OAuth creds for a source connector, or empty placeholders. Backfill only
 * needs the per-org access token from the connect flow; empty creds just mean
 * "no real OAuth handshake available" (the connect-with-token path still works).
 */
function oauth(config: CoreConfig, creds?: { clientId: string; clientSecret: string; redirectUri: string }) {
  return creds ?? { clientId: "", clientSecret: "", redirectUri: config.appUrl };
}

/** The full integration catalog. Source rows carry a `create` factory. */
export const CONNECTORS: ConnectorDef[] = [
  {
    name: "notion",
    label: "Notion",
    category: "Docs & wiki",
    kind: "source",
    configured: (c) => Boolean(c.notion),
    create: (c) => new NotionConnector(oauth(c, c.notion))
  },
  {
    name: "google_drive",
    label: "Google Drive",
    category: "Files",
    kind: "source",
    configured: (c) => Boolean(c.googleDrive),
    create: (c) => new GoogleDriveConnector(oauth(c, c.googleDrive))
  },
  {
    name: "github",
    label: "GitHub",
    category: "Code & PRs",
    kind: "source",
    configured: (c) => Boolean(c.github),
    create: (c) => new GitHubConnector(oauth(c, c.github))
  },
  {
    name: "gmail",
    label: "Gmail",
    category: "Email",
    kind: "source",
    configured: (c) => Boolean(c.gmail),
    create: (c) => new GmailConnector(oauth(c, c.gmail))
  },
  {
    name: "google_calendar",
    label: "Google Calendar",
    category: "Calendar",
    kind: "source",
    configured: (c) => Boolean(c.googleCalendar),
    create: (c) => new GoogleCalendarConnector(oauth(c, c.googleCalendar))
  },
  {
    name: "slack",
    label: "Slack",
    category: "Chat",
    kind: "source",
    configured: (c) => Boolean(c.slack),
    create: (c) => new SlackSourceConnector(oauth(c))
  },
  {
    // Webhook connector: registered in the ConnectorRegistry (event-driven), no
    // OAuth handshake, "connected" only after it receives an event.
    name: "zoom",
    label: "Zoom",
    category: "Meetings",
    kind: "webhook",
    configured: () => true
  },
  {
    name: "jira",
    label: "Jira",
    category: "Tickets",
    kind: "outbound",
    configured: (c) => Boolean(c.jira)
  }
];

/** Catalog rows (name/label/category/kind) for status computation + the UI. */
export const CONNECTOR_CATALOG = CONNECTORS.map(({ name, label, category, kind }) => ({ name, label, category, kind }));

const BY_NAME = new Map(CONNECTORS.map((d) => [d.name, d] as const));

/** Look up a connector definition by name. */
export function connectorDef(name: string): ConnectorDef | undefined {
  return BY_NAME.get(name);
}
