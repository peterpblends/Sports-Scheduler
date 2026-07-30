import { z } from 'zod'
import { ROLES } from './authz'

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('Enter a valid email address.')
  .transform((v) => v.toLowerCase())

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(200, 'That password is too long.')

export const nameSchema = z.string().trim().min(1, 'Required.').max(120)

export const roleSchema = z.enum(ROLES)

/** Roles an invitation may grant. Ownership transfers are a separate action. */
export const invitableRoleSchema = z.enum(['admin', 'scheduler', 'coach', 'referee', 'viewer'])

export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isValidTimezone, 'Unknown IANA time zone.')

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export const signupSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
})

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Required.'),
})

export const forgotPasswordSchema = z.object({ email: emailSchema })

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password: passwordSchema,
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
})

export const createOrgSchema = z.object({
  name: nameSchema,
  timezone: timezoneSchema.default('America/Los_Angeles'),
})

export const inviteSchema = z.object({
  email: emailSchema,
  role: invitableRoleSchema,
})

export const updateRoleSchema = z.object({ role: roleSchema })

export const acceptInviteSchema = z.object({
  token: z.string().min(10),
  // Only used when the invitee does not have an account yet.
  name: nameSchema.optional(),
  password: passwordSchema.optional(),
})

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 48) || 'org'
  )
}
