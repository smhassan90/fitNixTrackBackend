/**
 * Gym-facing member number helpers.
 * `Member.id` is the internal PK (API routing/FKs only).
 * `legacyMemberId` / `memberNumber` is what staff and members see.
 */

export const memberPublicSelect = {
  id: true,
  legacyMemberId: true,
  name: true,
  email: true,
  phone: true,
} as const;

export const memberReceiptSelect = {
  id: true,
  legacyMemberId: true,
  name: true,
  email: true,
  phone: true,
  cnic: true,
  membershipStart: true,
  membershipEnd: true,
  billingResumeFrom: true,
  monthlyPaymentAmount: true,
  discount: true,
  isActive: true,
  admissionFeeWaived: true,
  admissionFeePaid: true,
  oneTimePaymentPaid: true,
} as const;

export type MemberNumberSource = {
  id?: number;
  legacyMemberId?: string | null;
};

/** Display member number (legacy ID). Never fall back to PK for UI. */
export function getMemberNumber(member: MemberNumberSource | null | undefined): string | null {
  const value = member?.legacyMemberId?.trim();
  return value || null;
}

export function withMemberNumber<T extends MemberNumberSource>(member: T): T & { memberNumber: string | null } {
  return {
    ...member,
    memberNumber: getMemberNumber(member),
  };
}

export function mapRowMemberNumber<T extends { member?: MemberNumberSource | null }>(
  row: T
): T & { member?: (NonNullable<T['member']> & { memberNumber: string | null }) | null | undefined } {
  if (!row.member) {
    return row as T & { member?: undefined };
  }
  return {
    ...row,
    member: withMemberNumber(row.member),
  };
}

export function mapRowsMemberNumber<T extends { member?: MemberNumberSource | null }>(
  rows: T[]
): Array<T & { member?: (NonNullable<T['member']> & { memberNumber: string | null }) | null | undefined }> {
  return rows.map((row) => mapRowMemberNumber(row));
}
