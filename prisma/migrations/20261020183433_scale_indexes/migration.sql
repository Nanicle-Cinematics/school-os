-- CreateIndex
CREATE INDEX "InvoiceItem_feeCategoryId_idx" ON "InvoiceItem"("feeCategoryId");

-- CreateIndex
CREATE INDEX "Payment_studentId_idx" ON "Payment"("studentId");

-- CreateIndex
CREATE INDEX "TermResult_studentId_idx" ON "TermResult"("studentId");
