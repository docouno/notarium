use super::{MAX_DIMENSION, MIN_DIMENSION, VectorError};

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct QuantizedVector {
    scale: f32,
    values: Vec<i8>,
}

impl QuantizedVector {
    pub fn quantize(values: &[f32]) -> Result<Self, VectorError> {
        if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&values.len()) {
            return Err(VectorError::InvalidDimension);
        }
        let squared_norm = values
            .iter()
            .map(|&value| f64::from(value).powi(2))
            .sum::<f64>();
        if !squared_norm.is_finite() || squared_norm <= 0.0 {
            return Err(VectorError::InvalidVector);
        }
        let norm = squared_norm.sqrt();
        if !norm.is_finite() || norm <= 0.0 {
            return Err(VectorError::InvalidVector);
        }
        let abs_max = values
            .iter()
            .map(|&value| f64::from(value).abs())
            .fold(0.0, f64::max)
            / norm;
        let scale = (abs_max / 127.0) as f32;
        if !scale.is_finite() || scale <= 0.0 || scale > 1.0 {
            return Err(VectorError::InvalidVector);
        }
        let denominator = norm * f64::from(scale);
        let mut quantized: Vec<i8> = values
            .iter()
            .map(|&value| {
                (f64::from(value) / denominator)
                    .round()
                    .clamp(-127.0, 127.0) as i8
            })
            .collect();
        quantized.resize(values.len().next_multiple_of(64), 0);
        Ok(Self {
            scale,
            values: quantized,
        })
    }

    pub fn from_parts(scale: f32, values: Vec<i8>, dimension: usize) -> Result<Self, VectorError> {
        let vector = Self { scale, values };
        vector.validate(dimension)?;
        Ok(vector)
    }

    pub(super) fn validate(&self, dimension: usize) -> Result<(), VectorError> {
        if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&dimension)
            || self.values.len() != dimension.next_multiple_of(64)
        {
            return Err(VectorError::InvalidDimension);
        }
        if !self.scale.is_finite()
            || self.scale <= 0.0
            || self.scale > 1.0
            || self.values[..dimension].contains(&i8::MIN)
            || self.values[dimension..].iter().any(|&value| value != 0)
        {
            return Err(VectorError::InvalidVector);
        }
        Ok(())
    }

    pub fn scale(&self) -> f32 {
        self.scale
    }

    pub fn values(&self) -> &[i8] {
        &self.values
    }
}
