import { z } from "zod";

import { PAYPAL_CAPTURE_STATUSES } from "@/server/domain/payment-status";

export const moneySchema = z.object({
  currency_code: z.string().length(3),
  value: z.string().regex(/^\d+(?:\.\d+)?$/),
});

export const captureSchema = z.object({
  id: z.string().min(1),
  status: z.enum(PAYPAL_CAPTURE_STATUSES),
  amount: moneySchema,
  custom_id: z.string().optional(),
  create_time: z.string().datetime().optional(),
  update_time: z.string().datetime().optional(),
  supplementary_data: z
    .object({
      related_ids: z.object({ order_id: z.string().min(1).optional() }).passthrough(),
    })
    .optional(),
});

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().min(1),
});

export const createOrderResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  links: z.array(
    z.object({
      href: z.string().url(),
      rel: z.string().min(1),
      method: z.string().optional(),
    }),
  ),
});

export const captureOrderResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  purchase_units: z
    .array(
      z.object({
        custom_id: z.string().optional(),
        payments: z.object({ captures: z.array(captureSchema).min(1) }),
      }),
    )
    .min(1),
});

export const verifyWebhookResponseSchema = z.object({
  verification_status: z.enum(["SUCCESS", "FAILURE"]),
});

export const webhookEventBaseSchema = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  create_time: z.string().datetime().optional(),
  resource: z.unknown(),
});

export const captureCompletedWebhookSchema = webhookEventBaseSchema.extend({
  event_type: z.literal("PAYMENT.CAPTURE.COMPLETED"),
  resource: captureSchema,
});

export type CaptureDetails = z.infer<typeof captureSchema>;
