import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create gyms
  const gym1 = await prisma.gym.create({
    data: {
      name: 'FitNix Gym - Main Branch',
      address: '123 Main Street, Karachi',
      phone: '+92-300-1234567',
      email: 'main@fitnix.com',
    },
  });

  const gym2 = await prisma.gym.create({
    data: {
      name: 'FitNix Gym - Downtown Branch',
      address: '456 Downtown Avenue, Lahore',
      phone: '+92-300-7654321',
      email: 'downtown@fitnix.com',
    },
  });

  console.log('✅ Created gyms');

  // Create users
  const hashedPassword = await bcrypt.hash('password123', 10);

  const admin1 = await prisma.user.create({
    data: {
      name: 'Admin User',
      email: 'admin@fitnix.com',
      password: hashedPassword,
      role: 'GYM_ADMIN',
      gymId: gym1.id,
      gymName: gym1.name,
    },
  });

  const staff1 = await prisma.user.create({
    data: {
      name: 'Staff User',
      email: 'staff@fitnix.com',
      password: hashedPassword,
      role: 'STAFF',
      gymId: gym1.id,
      gymName: gym1.name,
    },
  });

  const admin2 = await prisma.user.create({
    data: {
      name: 'Admin User 2',
      email: 'admin2@fitnix.com',
      password: hashedPassword,
      role: 'GYM_ADMIN',
      gymId: gym2.id,
      gymName: gym2.name,
    },
  });

  console.log('✅ Created users');

  // Create packages for gym1
  const package1 = await prisma.package.create({
    data: {
      id: `package-${gym1.id}-${randomUUID()}`,
      gymId: gym1.id,
      name: 'Basic Package',
      price: 5000,
      duration: '1 month',
      features: ['Gym Access', 'Locker', 'Shower'],
    },
  });

  const package2 = await prisma.package.create({
    data: {
      id: `package-${gym1.id}-${randomUUID()}`,
      gymId: gym1.id,
      name: 'Premium Package',
      price: 12000,
      duration: '3 months',
      features: ['Gym Access', 'Locker', 'Shower', 'Personal Trainer', 'Nutrition Plan'],
    },
  });

  const package3 = await prisma.package.create({
    data: {
      id: `package-${gym1.id}-${randomUUID()}`,
      gymId: gym1.id,
      name: 'Annual Package',
      price: 40000,
      duration: '12 months',
      features: [
        'Gym Access',
        'Locker',
        'Shower',
        'Personal Trainer',
        'Nutrition Plan',
        'Group Classes',
        'Spa Access',
      ],
    },
  });

  console.log('✅ Created packages');

  // Create trainers for gym1
  const trainer1 = await prisma.trainer.create({
    data: {
      id: `trainer-${gym1.id}-${randomUUID()}`,
      gymId: gym1.id,
      name: 'John Trainer',
      gender: 'Male',
      specialization: 'Weight Training, Bodybuilding',
      charges: 5000,
      startTime: '09:00',
      endTime: '18:00',
    },
  });

  const trainer2 = await prisma.trainer.create({
    data: {
      id: `trainer-${gym1.id}-${randomUUID()}`,
      gymId: gym1.id,
      name: 'Sarah Trainer',
      gender: 'Female',
      specialization: 'Yoga, Pilates, Cardio',
      charges: 4500,
      startTime: '10:00',
      endTime: '19:00',
    },
  });

  console.log('✅ Created trainers');

  // Create members for gym1 (IDs will be auto-generated)
  const member1 = await prisma.member.create({
    data: {
      gymId: gym1.id,
      name: 'Ahmed Ali',
      phone: '+92-300-1111111',
      email: 'ahmed@example.com',
      gender: 'Male',
      dateOfBirth: new Date('1990-05-15'),
      cnic: '1234567890123',
      packageId: package1.id,
      membershipStart: new Date('2024-01-01'),
      trainers: {
        create: {
          trainerId: trainer1.id,
        },
      },
    },
  });

  const member2 = await prisma.member.create({
    data: {
      gymId: gym1.id,
      name: 'Fatima Khan',
      phone: '+92-300-2222222',
      email: 'fatima@example.com',
      gender: 'Female',
      dateOfBirth: new Date('1995-08-20'),
      cnic: '9876543210987',
      packageId: package2.id,
      membershipStart: new Date('2024-01-15'),
      discount: 10,
      trainers: {
        create: [
          { trainerId: trainer1.id },
          { trainerId: trainer2.id },
        ],
      },
    },
  });

  const member3 = await prisma.member.create({
    data: {
      gymId: gym1.id,
      name: 'Hassan Raza',
      phone: '+92-300-3333333',
      email: 'hassan@example.com',
      gender: 'Male',
      packageId: package3.id,
      membershipStart: new Date('2024-02-01'),
    },
  });

  console.log('✅ Created members');

  // Create some payments
  const payment1 = await prisma.payment.create({
    data: {
      id: `payment-${gym1.id}-${randomUUID()}`,
      gymId: gym1.id,
      memberId: member1.id,
      month: '2024-01',
      amount: 5000,
      status: 'PAID',
      dueDate: new Date('2024-01-15'),
      paidDate: new Date('2024-01-10'),
    },
  });

  const payment2 = await prisma.payment.create({
    data: {
      id: `payment-${gym1.id}-${randomUUID()}`,
      gymId: gym1.id,
      memberId: member1.id,
      month: '2024-02',
      amount: 5000,
      status: 'PENDING',
      dueDate: new Date('2024-02-15'),
    },
  });

  const payment3 = await prisma.payment.create({
    data: {
      id: `payment-${gym1.id}-${randomUUID()}`,
      gymId: gym1.id,
      memberId: member2.id,
      month: '2024-01',
      amount: 12000,
      status: 'PAID',
      dueDate: new Date('2024-01-20'),
      paidDate: new Date('2024-01-18'),
    },
  });

  console.log('✅ Created payments');

  // Create some attendance records
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  await prisma.attendanceRecord.createMany({
    data: [
      {
        gymId: gym1.id,
        memberId: member1.id,
        date: today,
        status: 'PRESENT',
      },
      {
        gymId: gym1.id,
        memberId: member1.id,
        date: yesterday,
        status: 'PRESENT',
      },
      {
        gymId: gym1.id,
        memberId: member2.id,
        date: today,
        status: 'PRESENT',
      },
      {
        gymId: gym1.id,
        memberId: member3.id,
        date: yesterday,
        status: 'ABSENT',
      },
    ],
  });

  console.log('✅ Created attendance records');

  console.log('\n🎉 Seeding completed successfully!');
  console.log('\n📝 Test credentials:');
  console.log('   Admin: admin@fitnix.com / password123');
  console.log('   Staff: staff@fitnix.com / password123');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

