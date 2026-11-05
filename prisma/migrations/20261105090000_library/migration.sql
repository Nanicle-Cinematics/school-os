-- CreateEnum
CREATE TYPE "CopyStatus" AS ENUM ('ACTIVE', 'LOST', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "LoanOutcome" AS ENUM ('RETURNED', 'LOST');

-- AlterTable
ALTER TABLE "SchoolSettings" ADD COLUMN     "libraryBlockOverdue" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "libraryPupilDays" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "libraryPupilMax" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "libraryStaffDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "libraryStaffMax" INTEGER NOT NULL DEFAULT 5;

-- CreateTable
CREATE TABLE "Book" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "isbn" TEXT,
    "publisher" TEXT,
    "publishedYear" INTEGER,
    "category" TEXT,
    "shelf" TEXT,
    "replacementCost" DECIMAL(10,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Book_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookCopy" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "accessionNo" TEXT NOT NULL,
    "status" "CopyStatus" NOT NULL DEFAULT 'ACTIVE',
    "statusNote" TEXT,
    "statusChangedOn" DATE,
    "acquiredOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookCopy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryLoan" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "copyId" TEXT NOT NULL,
    "studentId" TEXT,
    "staffId" TEXT,
    "borrowedOn" DATE NOT NULL,
    "dueOn" DATE NOT NULL,
    "renewals" INTEGER NOT NULL DEFAULT 0,
    "returnedOn" DATE,
    "outcome" "LoanOutcome",
    "note" TEXT,
    "issuedByUserId" TEXT,
    "closedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryLoan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Book_schoolId_title_idx" ON "Book"("schoolId", "title");

-- CreateIndex
CREATE INDEX "Book_schoolId_category_idx" ON "Book"("schoolId", "category");

-- CreateIndex
CREATE INDEX "BookCopy_schoolId_bookId_idx" ON "BookCopy"("schoolId", "bookId");

-- CreateIndex
CREATE UNIQUE INDEX "BookCopy_schoolId_accessionNo_key" ON "BookCopy"("schoolId", "accessionNo");

-- CreateIndex
CREATE INDEX "LibraryLoan_schoolId_returnedOn_idx" ON "LibraryLoan"("schoolId", "returnedOn");

-- CreateIndex
CREATE INDEX "LibraryLoan_copyId_idx" ON "LibraryLoan"("copyId");

-- CreateIndex
CREATE INDEX "LibraryLoan_studentId_idx" ON "LibraryLoan"("studentId");

-- CreateIndex
CREATE INDEX "LibraryLoan_staffId_idx" ON "LibraryLoan"("staffId");

-- CreateIndex
CREATE INDEX "LibraryLoan_issuedByUserId_idx" ON "LibraryLoan"("issuedByUserId");

-- CreateIndex
CREATE INDEX "LibraryLoan_closedByUserId_idx" ON "LibraryLoan"("closedByUserId");

-- AddForeignKey
ALTER TABLE "Book" ADD CONSTRAINT "Book_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookCopy" ADD CONSTRAINT "BookCopy_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookCopy" ADD CONSTRAINT "BookCopy_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryLoan" ADD CONSTRAINT "LibraryLoan_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryLoan" ADD CONSTRAINT "LibraryLoan_copyId_fkey" FOREIGN KEY ("copyId") REFERENCES "BookCopy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryLoan" ADD CONSTRAINT "LibraryLoan_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryLoan" ADD CONSTRAINT "LibraryLoan_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryLoan" ADD CONSTRAINT "LibraryLoan_issuedByUserId_fkey" FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryLoan" ADD CONSTRAINT "LibraryLoan_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A loan goes to exactly one borrower: a pupil or a member of staff, never both and never neither.
ALTER TABLE "LibraryLoan" ADD CONSTRAINT "LibraryLoan_one_borrower_check"
  CHECK ((("studentId" IS NOT NULL)::int + ("staffId" IS NOT NULL)::int) = 1);

-- A loan is closed when it has a return date AND an outcome (returned or lost), and open when it has neither.
ALTER TABLE "LibraryLoan" ADD CONSTRAINT "LibraryLoan_closed_together_check"
  CHECK (("returnedOn" IS NULL) = ("outcome" IS NULL));
