// AI Model Response Types
export interface AIMessage {
  role: string;
  content: string;
}

export interface AIResponse {
  choices: Array<{
    message: AIMessage;
    index?: number;
    finish_reason?: string;
  }>;
}

// AI Binding Interface
export interface AIBinding {
  run(
    model: string,
    params: {
      messages: Array<{ role: string; content: string }>;
      max_tokens?: number;
      temperature?: number;
    },
  ): Promise<AIResponse>;
}
