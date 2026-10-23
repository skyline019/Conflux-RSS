FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npm run build
EXPOSE 3000
CMD ["sh", "scripts/start.sh"]
