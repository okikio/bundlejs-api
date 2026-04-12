import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = timestamp("created_at", { mode: "date", withTimezone: true })
  .defaultNow()
  .notNull();

const updatedAt = timestamp("updated_at", { mode: "date", withTimezone: true })
  .defaultNow()
  .$onUpdate(() => /* @__PURE__ */ new Date())
  .notNull();

const userTable = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  defaultCurrency: text("default_currency").notNull().default("CAD"),
  locale: text("locale").notNull().default("en-CA"),
  timezone: text("timezone").notNull().default("America/Toronto"),
  createdAt,
  updatedAt,
});

/** @ignore Internal Drizzle table export used by auth and DB composition. */
export const user: typeof userTable = userTable

const organizationTable = pgTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt,
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
  },
  (table) => [uniqueIndex("organization_slug_uidx").on(table.slug)],
);

/** @ignore Internal Drizzle table export used by auth and DB composition. */
export const organization: typeof organizationTable = organizationTable

const sessionTable = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt,
    updatedAt,
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

/** @ignore Internal Drizzle table export used by auth and DB composition. */
export const session: typeof sessionTable = sessionTable

const accountTable = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt,
    updatedAt,
  },
  (table) => [
    index("account_userId_idx").on(table.userId),
    uniqueIndex("account_provider_account_unique").on(table.providerId, table.accountId),
  ],
);

/** @ignore Internal Drizzle table export used by auth and DB composition. */
export const account: typeof accountTable = accountTable

const verificationTable = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

/** @ignore Internal Drizzle table export used by auth and DB composition. */
export const verification: typeof verificationTable = verificationTable

const jwksTable = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
});

/** @ignore Internal Drizzle table export used by auth and DB composition. */
export const jwks: typeof jwksTable = jwksTable

const memberTable = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt,
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
    uniqueIndex("member_organization_user_unique").on(table.organizationId, table.userId),
  ],
);

/** @ignore Internal Drizzle table export used by auth and DB composition. */
export const member: typeof memberTable = memberTable

const invitationTable = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    createdAt,
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

/** @ignore Internal Drizzle table export used by auth and DB composition. */
export const invitation: typeof invitationTable = invitationTable

const passkeyTable = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull().unique(),
    counter: integer("counter").notNull().default(0),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull().default(false),
    transports: text("transports"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow(),
    aaguid: text("aaguid"),
  },
  (table) => [index("passkey_userId_idx").on(table.userId)],
);

/** @ignore Internal Drizzle table export used by auth and DB composition. */
export const passkey: typeof passkeyTable = passkeyTable

const oauthClientTable = pgTable("oauth_client", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  disabled: boolean("disabled").default(false),
  skipConsent: boolean("skip_consent"),
  enableEndSession: boolean("enable_end_session"),
  subjectType: text("subject_type"),
  scopes: text("scopes").array(),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }),
  name: text("name"),
  uri: text("uri"),
  icon: text("icon"),
  contacts: text("contacts").array(),
  tos: text("tos"),
  policy: text("policy"),
  softwareId: text("software_id"),
  softwareVersion: text("software_version"),
  softwareStatement: text("software_statement"),
  redirectUris: text("redirect_uris").array().notNull(),
  postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  grantTypes: text("grant_types").array(),
  responseTypes: text("response_types").array(),
  public: boolean("public"),
  type: text("type"),
  requirePKCE: boolean("require_pkce"),
  referenceId: text("reference_id"),
  metadata: jsonb("metadata"),
});

/** @ignore Internal Drizzle table export used by auth and DB composition. */
export const oauthClient: typeof oauthClientTable = oauthClientTable

const oauthRefreshTokenTable = pgTable("oauth_refresh_token", {
  id: text("id").primaryKey(),
  token: text("token").notNull(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => session.id, {
    onDelete: "set null",
  }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }),
  revoked: timestamp("revoked", { mode: "date", withTimezone: true }),
  authTime: timestamp("auth_time", { mode: "date", withTimezone: true }),
  scopes: text("scopes").array().notNull(),
});

/** @ignore Internal Drizzle table export used by auth and DB composition. */
export const oauthRefreshToken: typeof oauthRefreshTokenTable = oauthRefreshTokenTable

const oauthAccessTokenTable = pgTable("oauth_access_token", {
  id: text("id").primaryKey(),
  token: text("token").unique(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => session.id, {
    onDelete: "set null",
  }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
    onDelete: "cascade",
  }),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }),
  scopes: text("scopes").array().notNull(),
});

/** @ignore Internal Drizzle table export used by auth and DB composition. */
export const oauthAccessToken: typeof oauthAccessTokenTable = oauthAccessTokenTable

const oauthConsentTable = pgTable("oauth_consent", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  scopes: text("scopes").array().notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }),
});

/** @ignore Internal Drizzle table export used by auth and DB composition. */
export const oauthConsent: typeof oauthConsentTable = oauthConsentTable

const userRelationsValue = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  invitations: many(invitation),
  passkeys: many(passkey),
  oauthClients: many(oauthClient),
  oauthRefreshTokens: many(oauthRefreshToken),
  oauthAccessTokens: many(oauthAccessToken),
  oauthConsents: many(oauthConsent),
}));

/** @ignore Internal Drizzle relation export used by auth and DB composition. */
export const userRelations: typeof userRelationsValue = userRelationsValue

const sessionRelationsValue = relations(session, ({ one, many }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
  activeOrganization: one(organization, {
    fields: [session.activeOrganizationId],
    references: [organization.id],
  }),
  oauthRefreshTokens: many(oauthRefreshToken),
  oauthAccessTokens: many(oauthAccessToken),
}));

/** @ignore Internal Drizzle relation export used by auth and DB composition. */
export const sessionRelations: typeof sessionRelationsValue = sessionRelationsValue

const accountRelationsValue = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

/** @ignore Internal Drizzle relation export used by auth and DB composition. */
export const accountRelations: typeof accountRelationsValue = accountRelationsValue

const organizationRelationsValue = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
  sessions: many(session),
}));

/** @ignore Internal Drizzle relation export used by auth and DB composition. */
export const organizationRelations: typeof organizationRelationsValue = organizationRelationsValue

const memberRelationsValue = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [member.userId],
    references: [user.id],
  }),
}));

/** @ignore Internal Drizzle relation export used by auth and DB composition. */
export const memberRelations: typeof memberRelationsValue = memberRelationsValue

const invitationRelationsValue = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}));

/** @ignore Internal Drizzle relation export used by auth and DB composition. */
export const invitationRelations: typeof invitationRelationsValue = invitationRelationsValue

const passkeyRelationsValue = relations(passkey, ({ one }) => ({
  user: one(user, {
    fields: [passkey.userId],
    references: [user.id],
  }),
}));

/** @ignore Internal Drizzle relation export used by auth and DB composition. */
export const passkeyRelations: typeof passkeyRelationsValue = passkeyRelationsValue

const oauthClientRelationsValue = relations(oauthClient, ({ one, many }) => ({
  user: one(user, {
    fields: [oauthClient.userId],
    references: [user.id],
  }),
  oauthRefreshTokens: many(oauthRefreshToken),
  oauthAccessTokens: many(oauthAccessToken),
  oauthConsents: many(oauthConsent),
}));

/** @ignore Internal Drizzle relation export used by auth and DB composition. */
export const oauthClientRelations: typeof oauthClientRelationsValue = oauthClientRelationsValue

const oauthRefreshTokenRelationsValue = relations(
  oauthRefreshToken,
  ({ one, many }) => ({
    oauthClient: one(oauthClient, {
      fields: [oauthRefreshToken.clientId],
      references: [oauthClient.clientId],
    }),
    session: one(session, {
      fields: [oauthRefreshToken.sessionId],
      references: [session.id],
    }),
    user: one(user, {
      fields: [oauthRefreshToken.userId],
      references: [user.id],
    }),
    oauthAccessTokens: many(oauthAccessToken),
  }),
);

/** @ignore Internal Drizzle relation export used by auth and DB composition. */
export const oauthRefreshTokenRelations: typeof oauthRefreshTokenRelationsValue = oauthRefreshTokenRelationsValue

const oauthAccessTokenRelationsValue = relations(
  oauthAccessToken,
  ({ one }) => ({
    oauthClient: one(oauthClient, {
      fields: [oauthAccessToken.clientId],
      references: [oauthClient.clientId],
    }),
    session: one(session, {
      fields: [oauthAccessToken.sessionId],
      references: [session.id],
    }),
    user: one(user, {
      fields: [oauthAccessToken.userId],
      references: [user.id],
    }),
    oauthRefreshToken: one(oauthRefreshToken, {
      fields: [oauthAccessToken.refreshId],
      references: [oauthRefreshToken.id],
    }),
  }),
);

/** @ignore Internal Drizzle relation export used by auth and DB composition. */
export const oauthAccessTokenRelations: typeof oauthAccessTokenRelationsValue = oauthAccessTokenRelationsValue

const oauthConsentRelationsValue = relations(oauthConsent, ({ one }) => ({
  oauthClient: one(oauthClient, {
    fields: [oauthConsent.clientId],
    references: [oauthClient.clientId],
  }),
  user: one(user, {
    fields: [oauthConsent.userId],
    references: [user.id],
  }),
}));

/** @ignore Internal Drizzle relation export used by auth and DB composition. */
export const oauthConsentRelations: typeof oauthConsentRelationsValue = oauthConsentRelationsValue

/** Shared Drizzle schema object passed to Better Auth and backend services. */
export const schema = {
  user,
  session,
  account,
  verification,
  jwks,
  organization,
  member,
  invitation,
  passkey,
  oauthClient,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  userRelations,
  sessionRelations,
  accountRelations,
  organizationRelations,
  memberRelations,
  invitationRelations,
  passkeyRelations,
  oauthClientRelations,
  oauthRefreshTokenRelations,
  oauthAccessTokenRelations,
  oauthConsentRelations,
};

/** Selected row shape for the Better Auth user table. */
export type User = typeof user.$inferSelect;

/** Selected row shape for the Better Auth session table. */
export type Session = typeof session.$inferSelect;

/** Selected row shape for the Better Auth organization table. */
export type Organization = typeof organization.$inferSelect;

/** Selected row shape for the Better Auth membership table. */
export type Member = typeof member.$inferSelect;
