import os; os.environ['KERAS_BACKEND']='tensorflow'; os.environ['TF_CPP_MIN_LOG_LEVEL']='3'
import fast_plate_ocr.train.model.layers
import keras, tensorflow as tf
m=keras.models.load_model('/home/user/PAY-PARKING/training/models/reader_v4.keras', compile=False)
x=keras.Input((64,128,3), batch_size=1, dtype='uint8'); y=m(keras.ops.cast(x,'float32'))
w=keras.Model(x, y[0] if isinstance(y,(list,tuple)) else y)
c=tf.lite.TFLiteConverter.from_keras_model(w); c.optimizations=[tf.lite.Optimize.DEFAULT]
open('plate_reader.tflite','wb').write(c.convert()); print('size', os.path.getsize('plate_reader.tflite'))
