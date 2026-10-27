FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY web ./web
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /conferencia .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=build /conferencia /app/conferencia
EXPOSE 3000
ENTRYPOINT ["/app/conferencia"]
