export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
}

export interface InvoiceData {
  invoiceNumber: string;
  issueDate: string; // YYYY/MM/DD
  dueDate: string;
  client: {
    name: string;
    honorific?: string; // 御中, 様 etc.
  };
  issuer: {
    name: string;
    representative: string;
    address: string;
    postalCode: string;
    phone: string;
    email: string;
    registrationNumber?: string; // T+13 digits for インボイス制度
  };
  lineItems: InvoiceLineItem[];
  subtotal: number;
  taxRate: number; // 0.10
  taxAmount: number;
  total: number;
  withholding?: {
    rate: number; // 0.1021
    amount: number;
  };
  netAmount: number; // total - withholding (actual payment amount)
  bankInfo: {
    bankName: string;
    branchName: string;
    branchCode: string;
    accountType: string;
    accountNumber: string;
    accountHolder: string;
  };
  notes?: string;
}
