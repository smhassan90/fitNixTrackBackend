-- Migration: Add admission fee and one-time payment support
-- This migration adds:
-- 1. admissionFee field to gyms table
-- 2. Payment tracking fields to members table
-- 3. one_time_payments table for recording one-time payments

-- Add admissionFee to gyms table
ALTER TABLE gyms 
ADD COLUMN admissionFee FLOAT DEFAULT 0 AFTER email;

-- Add payment tracking fields to members table
ALTER TABLE members
ADD COLUMN admissionFeeWaived BOOLEAN DEFAULT FALSE AFTER discount,
ADD COLUMN admissionFeePaid FLOAT DEFAULT 0 AFTER admissionFeeWaived,
ADD COLUMN oneTimePaymentAmount FLOAT NULL AFTER admissionFeePaid,
ADD COLUMN oneTimePaymentPaid BOOLEAN DEFAULT FALSE AFTER oneTimePaymentAmount,
ADD COLUMN monthlyPaymentAmount FLOAT NULL AFTER oneTimePaymentPaid;

-- Create one_time_payments table
CREATE TABLE one_time_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  gymId INT NOT NULL,
  memberId INT NOT NULL,
  admissionFee FLOAT DEFAULT 0 NOT NULL,
  packageFee FLOAT DEFAULT 0 NOT NULL,
  trainerFee FLOAT DEFAULT 0 NOT NULL,
  totalAmount FLOAT NOT NULL,
  status ENUM('PENDING', 'PAID', 'OVERDUE') DEFAULT 'PENDING' NOT NULL,
  paidDate DATETIME NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL,
  INDEX idx_gymId (gymId),
  INDEX idx_memberId (memberId),
  INDEX idx_status (status),
  FOREIGN KEY (gymId) REFERENCES gyms(id) ON DELETE CASCADE,
  FOREIGN KEY (memberId) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;










