"""
Exception Handler for MMS
Handles errors in Kafka consumer, gRPC calls, and MongoDB operations
"""
import logging
import asyncio
from typing import Callable, Optional, Any
from functools import wraps

logger = logging.getLogger(__name__)


class MMSException(Exception):
    """Base exception for MMS"""
    pass


class KafkaConsumerError(MMSException):
    """Kafka consumer error"""
    pass


class GrpcError(MMSException):
    """gRPC communication error"""
    pass


class MongoDBError(MMSException):
    """MongoDB operation error"""
    pass


class ExceptionHandler:
    """
    Handles exceptions with retry logic and logging for MMS components
    """
    
    @staticmethod
    async def handle_kafka_consumer_error(
        error: Exception, 
        retry_fn: Callable,
        max_retries: int = 5,
        base_delay: float = 1.0
    ) -> Any:
        """
        Handle Kafka consumer errors with exponential backoff retry.
        
        Args:
            error: The error that occurred
            retry_fn: Async function to retry
            max_retries: Maximum number of retries
            base_delay: Base delay for exponential backoff
            
        Returns:
            Result of retry_fn if successful
            
        Raises:
            KafkaConsumerError: If all retries fail
        """
        logger.error(f"Kafka consumer error: {error}")
        
        for attempt in range(1, max_retries + 1):
            try:
                delay = base_delay * (2 ** (attempt - 1))
                logger.info(f"Kafka retry attempt {attempt}/{max_retries} after {delay}s delay")
                await asyncio.sleep(delay)
                return await retry_fn()
            except Exception as retry_error:
                logger.warning(f"Kafka retry {attempt} failed: {retry_error}")
                if attempt == max_retries:
                    raise KafkaConsumerError(f"All {max_retries} retry attempts failed") from retry_error
    
    @staticmethod
    async def handle_grpc_error(
        error: Exception,
        retry_fn: Callable,
        max_retries: int = 3,
        base_delay: float = 0.5
    ) -> Any:
        """
        Handle gRPC errors with exponential backoff retry.
        
        Args:
            error: The error that occurred
            retry_fn: Async function to retry
            max_retries: Maximum number of retries
            base_delay: Base delay for exponential backoff
            
        Returns:
            Result of retry_fn if successful
            
        Raises:
            GrpcError: If all retries fail
        """
        logger.error(f"gRPC error: {error}")
        
        for attempt in range(1, max_retries + 1):
            try:
                delay = base_delay * (2 ** (attempt - 1))
                logger.info(f"gRPC retry attempt {attempt}/{max_retries} after {delay}s delay")
                await asyncio.sleep(delay)
                return await retry_fn()
            except Exception as retry_error:
                logger.warning(f"gRPC retry {attempt} failed: {retry_error}")
                if attempt == max_retries:
                    raise GrpcError(f"All {max_retries} retry attempts failed") from retry_error
    
    @staticmethod
    def handle_mongodb_error(
        error: Exception,
        operation: str,
        context: Optional[dict] = None
    ) -> None:
        """
        Handle MongoDB errors by logging and potentially notifying.
        
        Args:
            error: The error that occurred
            operation: Name of the operation that failed
            context: Additional context about the operation
        """
        logger.error(f"MongoDB error during {operation}: {error}", extra=context or {})
        # Could add notification logic here (e.g., send to monitoring system)
    
    @staticmethod
    def with_retry(
        max_retries: int = 3,
        base_delay: float = 0.5,
        exceptions: tuple = (Exception,)
    ):
        """
        Decorator for sync functions with retry logic.
        
        Args:
            max_retries: Maximum number of retries
            base_delay: Base delay for exponential backoff
            exceptions: Tuple of exceptions to catch
        """
        def decorator(func: Callable):
            @wraps(func)
            def wrapper(*args, **kwargs):
                last_error = None
                for attempt in range(1, max_retries + 1):
                    try:
                        return func(*args, **kwargs)
                    except exceptions as e:
                        last_error = e
                        if attempt < max_retries:
                            delay = base_delay * (2 ** (attempt - 1))
                            logger.warning(f"Retry {attempt}/{max_retries} for {func.__name__} after {delay}s: {e}")
                            import time
                            time.sleep(delay)
                        else:
                            logger.error(f"All retries exhausted for {func.__name__}: {e}")
                raise last_error
            return wrapper
        return decorator
    
    @staticmethod
    def async_with_retry(
        max_retries: int = 3,
        base_delay: float = 0.5,
        exceptions: tuple = (Exception,)
    ):
        """
        Decorator for async functions with retry logic.
        
        Args:
            max_retries: Maximum number of retries
            base_delay: Base delay for exponential backoff
            exceptions: Tuple of exceptions to catch
        """
        def decorator(func: Callable):
            @wraps(func)
            async def wrapper(*args, **kwargs):
                last_error = None
                for attempt in range(1, max_retries + 1):
                    try:
                        return await func(*args, **kwargs)
                    except exceptions as e:
                        last_error = e
                        if attempt < max_retries:
                            delay = base_delay * (2 ** (attempt - 1))
                            logger.warning(f"Retry {attempt}/{max_retries} for {func.__name__} after {delay}s: {e}")
                            await asyncio.sleep(delay)
                        else:
                            logger.error(f"All retries exhausted for {func.__name__}: {e}")
                raise last_error
            return wrapper
        return decorator


# Global instance
exception_handler = ExceptionHandler()
