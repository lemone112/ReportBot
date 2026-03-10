export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  OPENAI_API_KEY: string;
  GEMINI_API_KEY: string;
  LINEAR_API_KEY: string;
  LINEAR_TEAM_ID: string;
  ALLOWED_CHATS: string;
  ADMIN_USERS: string;
  BUG_REPORTS: KVNamespace;
  MEDIA_BUCKET: R2Bucket;
  WEBHOOK_SECRET?: string;
  LINEAR_WEBHOOK_SECRET?: string;
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;
}

// --- Telegram types ---

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  my_chat_member?: TelegramMyChatMember;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  video?: TelegramVideo;
  document?: TelegramDocument;
  media_group_id?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  thumbnail?: TelegramPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  thumbnail?: TelegramPhotoSize;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramMyChatMember {
  chat: TelegramChat;
  from: TelegramUser;
  new_chat_member: {
    status: string;
    user: TelegramUser;
  };
}

// --- App types ---

export interface BugReport {
  title: string;
  description: string;
  priority: number;
  labels: string[];
  assignee?: string | null;
}

export interface IssueMapping {
  chatId: number;
  messageId: number;
  reporterName: string;
  issueId: string;
  issueUrl: string;
  title: string;
}

export interface MediaGroupBuffer {
  chatId: number;
  text: string;
  reporterName: string;
  firstMessageId: number;
  photos: string[];       // file_ids
  videoFileIds: string[];  // video file_ids
  videoThumbIds: string[]; // video thumbnail file_ids
  timestamp: number;
}

export interface PendingReject {
  linearIssueId: string;
  issueId: string;
  botMessageChatId: number;
  botMessageId: number;
}

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
}

export interface TeamRole {
  name: string;
  member?: TeamMember;
}

export type TeamConfig = Record<string, TeamRole>;

export interface PendingTeamSet {
  role: string;
  panelChatId: number;
  panelMessageId: number;
}

export interface PendingTeamName {
  panelChatId: number;
  panelMessageId: number;
}

export interface PendingReport {
  panelChatId: number;
  panelMessageId: number;
}

export interface LinearWebhookPayload {
  action: string;
  type: string;
  data: {
    id: string;
    identifier: string;
    title: string;
    state?: {
      id: string;
      name: string;
      type: string;
    };
  };
  updatedFrom?: Record<string, unknown>;
}

export interface LinearIssueListItem {
  identifier: string;
  title: string;
  url: string;
  stateName: string;
  stateType: string;
  priority: number;
  createdAt: string;
  completedAt: string;
  assignee: string;
}

export interface LinearWorkspaceUser {
  id: string;
  name: string;
  email: string;
}
