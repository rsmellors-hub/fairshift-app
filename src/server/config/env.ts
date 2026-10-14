import { z } from "zod";

const databaseSchema = z.object({
  DATABASE_URL: z.string().url().refine(
    (value) => value.startsWith("postgresql://") || value.startsWith("postgres://"),
    "DATABASE_URL must use postgres:// or postgresql://",
  ),
});

const aiSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default("gpt-6-luna"),
});

const paypalSchema = z.object({
  PAYPAL_ENV: z.literal("sandbox"),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_WEBHOOK_ID: z.string().min(1),
  APP_BASE_URL: z.string().url(),
  PAYPAL_SANDBOX_CURRENCY: z.literal("USD").default("USD"),
  PAYPAL_SANDBOX_AMOUNT: z.string().regex(/^\d+\.\d{2}$/).default("5.00"),
});

export type DatabaseConfig = z.infer<typeof databaseSchema>;
export type AiConfig = z.infer<typeof aiSchema>;
export type PayPalConfig = z.infer<typeof paypalSchema> & {
  apiBaseUrl: "https://api-m.sandbox.paypal.com";
};

export function getDatabaseConfig(): DatabaseConfig {
  return databaseSchema.parse(process.env);
}

export function getAiConfig(): AiConfig {
  return aiSchema.parse(process.env);
}

export function getPayPalConfig(): PayPalConfig {
  const parsed = paypalSchema.parse(process.env);
  return {
    ...parsed,
    apiBaseUrl: "https://api-m.sandbox.paypal.com",
  };
}

export function getConfigurationStatus() {
  const database = databaseSchema.safeParse(process.env);
  const paypal = paypalSchema.safeParse(process.env);
  const ai = aiSchema.safeParse(process.env);

  return {
    databaseConfigured: database.success,
    paypalConfigured: paypal.success,
    aiConfigured: ai.success,
    environment: process.env.PAYPAL_ENV === "sandbox" ? "SANDBOX" : "NOT CONFIGURED",
    currency: process.env.PAYPAL_SANDBOX_CURRENCY === "USD" ? "USD" : "USD",
    amount: /^\d+\.\d{2}$/.test(process.env.PAYPAL_SANDBOX_AMOUNT ?? "")
      ? process.env.PAYPAL_SANDBOX_AMOUNT!
      : "5.00",
  } as const;
}
