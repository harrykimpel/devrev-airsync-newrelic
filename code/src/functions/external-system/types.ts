export interface NewRelicAccount {
  id: number;
  name: string;
}

export interface NewRelicIssue {
  issueId: string;
  title: string[];
  description?: string[];
  priority: string;
  state: string;
  createdAt: number;
  updatedAt: number;
  entityNames?: string[];
  deepLinkUrl?: string;
}

export interface IssuePage {
  issues: NewRelicIssue[];
  nextCursor?: string | null;
}
