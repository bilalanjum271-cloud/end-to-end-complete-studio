FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/identity ./services/identity
RUN pnpm install --frozen-lockfile --filter @xen-studio/identity... && pnpm --filter @xen-studio/identity build \
 && pnpm --filter @xen-studio/identity deploy --prod --legacy /out && cp -r services/identity/dist /out/dist

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 8101
CMD ["node", "dist/src/main.js"]
