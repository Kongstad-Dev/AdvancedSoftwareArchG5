FROM node:18-alpine

WORKDIR /app

# Install curl for health check
RUN apk add --no-cache curl

# Copy package files
COPY pms/package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source code
COPY pms/src/ ./src/

# Copy proto files
COPY proto/ ./proto/

# Expose ports for HTTP and gRPC
EXPOSE 3000 50051

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["npm", "start"]
