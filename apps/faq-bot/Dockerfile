# Build a partir da raiz do repositório:
#   docker build -f apps/faq-bot/Dockerfile -t faq-bot .
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter @app/faq-bot...
ENV NODE_ENV=production PORT=3002
EXPOSE 3002
USER node
CMD ["pnpm", "--filter", "@app/faq-bot", "start"]
