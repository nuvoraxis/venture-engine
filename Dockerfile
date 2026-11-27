FROM node:20-alpine
WORKDIR /app
COPY products/ ./products/
COPY gateway/ ./gateway/
ENTRYPOINT ["node", "gateway/src/mcp_stdio.mjs"]
