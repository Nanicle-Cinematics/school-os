-- CreateTable
CREATE TABLE "TimetablePeriod" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "isBreak" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimetablePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableSlot" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "classGroupId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimetableSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimetablePeriod_schoolId_idx" ON "TimetablePeriod"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "TimetablePeriod_schoolId_order_key" ON "TimetablePeriod"("schoolId", "order");

-- CreateIndex
CREATE INDEX "TimetableSlot_schoolId_academicYearId_idx" ON "TimetableSlot"("schoolId", "academicYearId");

-- CreateIndex
CREATE INDEX "TimetableSlot_periodId_idx" ON "TimetableSlot"("periodId");

-- CreateIndex
CREATE INDEX "TimetableSlot_subjectId_idx" ON "TimetableSlot"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "TimetableSlot_classGroupId_academicYearId_weekday_periodId_key" ON "TimetableSlot"("classGroupId", "academicYearId", "weekday", "periodId");

-- AddForeignKey
ALTER TABLE "TimetablePeriod" ADD CONSTRAINT "TimetablePeriod_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_classGroupId_fkey" FOREIGN KEY ("classGroupId") REFERENCES "ClassGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableSlot" ADD CONSTRAINT "TimetableSlot_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "TimetablePeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

