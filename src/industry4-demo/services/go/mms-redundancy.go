package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/afex/hystrix-go/hystrix"
	"github.com/jhump/protoreflect/desc"
	"github.com/jhump/protoreflect/desc/protoparse"
	"github.com/jhump/protoreflect/dynamic"
	"github.com/rabbitmq/amqp091-go"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.uber.org/zap"
	"google.golang.org/grpc"
)

type healthServiceServer interface {
	mustEmbedHealthServiceServer()
}

type redundancyService struct {
	logger            *zap.SugaredLogger
	mongoClient       *mongo.Client
	mongoDatabase     string
	mongoCollection   string
	rabbitChannel     *amqp091.Channel
	alertQueue        string
	syncReqDesc       *desc.MessageDescriptor
	syncRespDesc      *desc.MessageDescriptor
	publishReqDesc    *desc.MessageDescriptor
	publishRespDesc   *desc.MessageDescriptor
	configCommandName string
	alertCommandName  string
}

func (s *redundancyService) mustEmbedHealthServiceServer() {}

func (s *redundancyService) syncConfigHandler(ctx context.Context, req *dynamic.Message) (*dynamic.Message, error) {
	factoryField := s.syncReqDesc.FindFieldByName("factory")
	factoryValue, _ := req.TryGetField(factoryField)
	s.logger.Infow("SyncConfig invoked", "factory", factoryValue)

	var response *dynamic.Message
	err := hystrix.Do(s.configCommandName, func() error {
		tmp := dynamic.NewMessage(s.syncRespDesc)
		tmp.SetField(s.syncRespDesc.FindFieldByName("healthy"), true)
		tmp.SetField(s.syncRespDesc.FindFieldByName("lastUpdated"), time.Now().UTC().Format(time.RFC3339))
		response = tmp
		return nil
	}, nil)
	if err != nil {
		s.logger.Warnw("Hystrix config-sync fallback", "error", err)
		fallback := dynamic.NewMessage(s.syncRespDesc)
		fallback.SetField(s.syncRespDesc.FindFieldByName("healthy"), true)
		fallback.SetField(s.syncRespDesc.FindFieldByName("lastUpdated"), time.Now().UTC().Format(time.RFC3339))
		response = fallback
	}

	return response, nil
}

func (s *redundancyService) publishHealthHandler(ctx context.Context, req *dynamic.Message) (*dynamic.Message, error) {
	sensorField := s.publishReqDesc.FindFieldByName("sensorId")
	anomalyField := s.publishReqDesc.FindFieldByName("anomaly")
	reasonField := s.publishReqDesc.FindFieldByName("reason")
	timestampField := s.publishReqDesc.FindFieldByName("timestamp")

	sensorID, _ := req.TryGetField(sensorField)
	anomalyValueRaw, _ := req.TryGetField(anomalyField)
	reasonValue, _ := req.TryGetField(reasonField)
	timestampValue, _ := req.TryGetField(timestampField)

	anomaly := anomalyValueRaw == true
	s.logger.Infow("PublishHealth received", "sensorId", sensorID, "anomaly", anomaly, "reason", reasonValue)

	resp := dynamic.NewMessage(s.publishRespDesc)
	resp.SetField(s.publishRespDesc.FindFieldByName("accepted"), true)

	if !anomaly {
		return resp, nil
	}

	payload := map[string]interface{}{
		"factory":   getenvDefault("DEFAULT_FACTORY", "factory-1"),
		"sensorId":  sensorID,
		"anomaly":   anomaly,
		"reason":    reasonValue,
		"timestamp": timestampValue,
	}

	parentCtx := ctx
	err := hystrix.Do(s.alertCommandName, func() error {
		timedCtx, cancel := context.WithTimeout(parentCtx, 2*time.Second)
		defer cancel()
		return s.processAnomaly(timedCtx, payload)
	}, func(err error) error {
		s.logger.Warnw("Hystrix fallback triggered", "error", err)
		return nil
	})
	if err != nil {
		s.logger.Errorw("Failed to process anomaly", "error", err)
		resp.SetField(s.publishRespDesc.FindFieldByName("accepted"), false)
	}

	return resp, nil
}

func (s *redundancyService) processAnomaly(ctx context.Context, payload map[string]interface{}) error {
	start := time.Now()
	collection := s.mongoClient.Database(s.mongoDatabase).Collection(s.mongoCollection)

	rerouteTarget := getenvDefault("REDUNDANCY_REROUTE_TARGET", "line-B")
	if _, err := collection.InsertOne(ctx, bson.M{
		"factory":        payload["factory"],
		"sensorId":       payload["sensorId"],
		"reason":         payload["reason"],
		"anomaly":        payload["anomaly"],
		"timestamp":      payload["timestamp"],
		"processedAt":    time.Now().UTC(),
		"rerouteTarget":  rerouteTarget,
		"latencyMs":      time.Since(start).Milliseconds(),
	}); err != nil {
		return fmt.Errorf("mongo insert: %w", err)
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	if err := s.rabbitChannel.PublishWithContext(
		ctx,
		"",
		s.alertQueue,
		false,
		false,
		amqp091.Publishing{
			ContentType: "application/json",
			Body:        body,
		},
	); err != nil {
		return fmt.Errorf("rabbit publish: %w", err)
	}

	s.logger.Infow("Reroute executed and alert published", "sensorId", payload["sensorId"])
	return nil
}

func parseDescriptors(protoPath string) (*desc.ServiceDescriptor, error) {
	parser := protoparse.Parser{
		ImportPaths:           []string{filepath.Dir(protoPath)},
		InferImportPaths:      true,
		IncludeSourceCodeInfo: true,
	}
	files, err := parser.ParseFiles(filepath.Base(protoPath))
	if err != nil {
		return nil, err
	}

	file := files[0]
	symbol, err := file.FindSymbol("health.HealthService")
	if err != nil {
		return nil, err
	}

	serviceDesc, ok := symbol.(*desc.ServiceDescriptor)
	if !ok {
		return nil, fmt.Errorf("failed to cast descriptor")
	}
	return serviceDesc, nil
}

func registerService(grpcServer *grpc.Server, svc *redundancyService) {
	serviceDesc := &grpc.ServiceDesc{
		ServiceName: "health.HealthService",
		HandlerType: (*healthServiceServer)(nil),
		Methods: []grpc.MethodDesc{
			{
				MethodName: "SyncConfig",
				Handler: func(srv interface{}, ctx context.Context, dec func(interface{}) error, interceptor grpc.UnaryServerInterceptor) (interface{}, error) {
					in := dynamic.NewMessage(svc.syncReqDesc)
					if err := dec(in); err != nil {
						return nil, err
					}
					if interceptor == nil {
						return svc.syncConfigHandler(ctx, in)
					}
					info := &grpc.UnaryServerInfo{
						Server:     srv,
						FullMethod: "/health.HealthService/SyncConfig",
					}
					handler := func(ctx context.Context, req interface{}) (interface{}, error) {
						return svc.syncConfigHandler(ctx, req.(*dynamic.Message))
					}
					return interceptor(ctx, in, info, handler)
				},
			},
			{
				MethodName: "PublishHealth",
				Handler: func(srv interface{}, ctx context.Context, dec func(interface{}) error, interceptor grpc.UnaryServerInterceptor) (interface{}, error) {
					in := dynamic.NewMessage(svc.publishReqDesc)
					if err := dec(in); err != nil {
						return nil, err
					}
					if interceptor == nil {
						return svc.publishHealthHandler(ctx, in)
					}
					info := &grpc.UnaryServerInfo{
						Server:     srv,
						FullMethod: "/health.HealthService/PublishHealth",
					}
					handler := func(ctx context.Context, req interface{}) (interface{}, error) {
						return svc.publishHealthHandler(ctx, req.(*dynamic.Message))
					}
					return interceptor(ctx, in, info, handler)
				},
			},
		},
		Streams:  []grpc.StreamDesc{},
		Metadata: "health.proto",
	}
	grpcServer.RegisterService(serviceDesc, svc)
}

func main() {
	logger, _ := zap.NewProduction()
	defer logger.Sync() //nolint:errcheck
	sugar := logger.Sugar()

	protoPath := filepath.Join("proto", "health.proto")
	serviceDesc, err := parseDescriptors(protoPath)
	if err != nil {
		sugar.Fatalw("Failed to parse proto descriptors", "error", err)
	}

	mongoURL := getenvDefault("MONGO_URL", "mongodb://localhost:27017")
	mongoClient, err := mongo.Connect(context.Background(), options.Client().ApplyURI(mongoURL))
	if err != nil {
		sugar.Fatalw("Mongo connection failed", "error", err)
	}
	defer func() {
		_ = mongoClient.Disconnect(context.Background())
	}()

	rabbitURL := getenvDefault("RABBITMQ_URL", "amqp://guest:guest@localhost:5672/")
	conn, err := amqp091.Dial(rabbitURL)
	if err != nil {
		sugar.Fatalw("RabbitMQ connection failed", "error", err)
	}
	defer func() {
		_ = conn.Close()
	}()
	channel, err := conn.Channel()
	if err != nil {
		sugar.Fatalw("RabbitMQ channel failed", "error", err)
	}
	defer func() {
		_ = channel.Close()
	}()
	alertQueue := getenvDefault("RABBITMQ_ALERT_QUEUE", "failure-alerts")
	if _, err := channel.QueueDeclare(alertQueue, false, false, false, false, nil); err != nil {
		sugar.Fatalw("Queue declaration failed", "error", err)
	}

	hystrix.ConfigureCommand("config-sync", hystrix.CommandConfig{
		Timeout:               1000,
		MaxConcurrentRequests: 50,
		ErrorPercentThreshold: 50,
	})
	hystrix.ConfigureCommand("anomaly-notify", hystrix.CommandConfig{
		Timeout:               1000,
		MaxConcurrentRequests: 100,
		ErrorPercentThreshold: 50,
	})

	svc := &redundancyService{
		logger:            sugar,
		mongoClient:       mongoClient,
		mongoDatabase:     getenvDefault("MONGO_DB", "logs"),
		mongoCollection:   getenvDefault("MONGO_COLLECTION", "anomalies"),
		rabbitChannel:     channel,
		alertQueue:        alertQueue,
		syncReqDesc:       serviceDesc.GetMethodByName("SyncConfig").GetInputType(),
		syncRespDesc:      serviceDesc.GetMethodByName("SyncConfig").GetOutputType(),
		publishReqDesc:    serviceDesc.GetMethodByName("PublishHealth").GetInputType(),
		publishRespDesc:   serviceDesc.GetMethodByName("PublishHealth").GetOutputType(),
		configCommandName: "config-sync",
		alertCommandName:  "anomaly-notify",
	}

	grpcServer := grpc.NewServer()
	registerService(grpcServer, svc)

	listener, err := net.Listen("tcp", ":50051")
	if err != nil {
		sugar.Fatalw("Failed to listen on port 50051", "error", err)
	}

	sugar.Infow("gRPC redundancy service started", "port", 50051)
	if err := grpcServer.Serve(listener); err != nil {
		log.Fatalf("gRPC server exited: %v", err)
	}
}

func getenvDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
