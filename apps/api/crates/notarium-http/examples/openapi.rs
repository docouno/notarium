fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", notarium_http::openapi().to_pretty_json()?);
    Ok(())
}
